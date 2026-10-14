#include "server.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <signal.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdio>
#include <utility>

#include "handlers.h"

namespace {

constexpr size_t kReadChunk = 64 * 1024;
// 对端一直不收就断开, 否则 out 缓冲能把内存拖爆
constexpr size_t kMaxOutBuf = 8u << 20;

std::string formatPeer(const sockaddr_storage& ss) {
    char host[NI_MAXHOST] = {0};
    char serv[NI_MAXSERV] = {0};
    if (::getnameinfo((const sockaddr*)&ss, sizeof ss, host, sizeof host, serv, sizeof serv,
                      NI_NUMERICHOST | NI_NUMERICSERV) != 0) {
        return "unknown";
    }
    return std::string(host) + ":" + serv;
}

}  // namespace

// ---------------------------------------------------------------- Connection

void Connection::send(const void* data, size_t len) {
    if (owner) owner->sendOn(*this, static_cast<const char*>(data), len);
}

void Connection::close() {
    if (owner) owner->closeConn(*this);
}

// -------------------------------------------------------------------- Server

Server::Server(uint16_t port, int workers) : port_(port), nworkers_(workers), pool_(workers) {}

Server::~Server() { stop(); }

bool Server::start() {
    ::signal(SIGPIPE, SIG_IGN);  // 对端先关时让 write 返回 EPIPE, 而不是干掉进程

    // 信号统一用 signalfd 收, 避免在信号处理函数里做异步不安全的事。
    // 必须在创建线程池之前屏蔽, 这样每个新线程都继承这个掩码。
    sigset_t mask;
    ::sigemptyset(&mask);
    ::sigaddset(&mask, SIGINT);
    ::sigaddset(&mask, SIGTERM);
    if (::pthread_sigmask(SIG_BLOCK, &mask, nullptr) != 0) {
        perror("pthread_sigmask");
        return false;
    }
    sigfd_ = ::signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
    if (sigfd_ < 0) {
        perror("signalfd");
        return false;
    }

    if (!acceptLoop_.init()) return false;
    if (!listenOn()) return false;
    if (!pool_.start()) return false;

    nworkers_ = (int)pool_.size();
    conns_.resize((size_t)nworkers_);

    if (!acceptLoop_.add(lfd_, EPOLLIN | EPOLLET, [this](uint32_t) { onAccept(); })) return false;
    if (!acceptLoop_.add(sigfd_, EPOLLIN, [this](uint32_t) { onSignal(); })) return false;

    running_ = true;
    std::fprintf(stderr, "[srv] listening on 0.0.0.0:%u with %d worker thread(s)\n", port_, nworkers_);
    return true;
}

int Server::run() {
    acceptLoop_.loop();  // 主线程就是 accept 线程
    stop();
    return 0;
}

void Server::stop() {
    if (stopped_.exchange(true)) return;
    running_ = false;

    if (lfd_ >= 0) {
        acceptLoop_.del(lfd_);
        ::close(lfd_);
        lfd_ = -1;
    }
    if (sigfd_ >= 0) {
        acceptLoop_.del(sigfd_);
        ::close(sigfd_);
        sigfd_ = -1;
    }
    acceptLoop_.stop();

    pool_.stop();  // 等所有 worker 退出后, 连接表不会再被别的线程碰

    // 进程要退了, 剩下的连接直接关, 不再走 onClose
    size_t alive = 0;
    for (auto& table : conns_) {
        for (auto& kv : table) {
            auto& c = kv.second;
            c->closed = true;
            if (c->fd >= 0) ::close(c->fd);
            ++alive;
        }
        table.clear();
    }
    if (alive) std::fprintf(stderr, "[srv] closed %zu leftover connection(s)\n", alive);
    std::fprintf(stderr, "[srv] stopped\n");
}

bool Server::listenOn() {
    // ponytail: 只监 IPv4。要 IPv6 就换 AF_INET6 + IPV6_V6ONLY=0 做双栈
    lfd_ = ::socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (lfd_ < 0) {
        perror("socket");
        return false;
    }

    const int one = 1;
    ::setsockopt(lfd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(port_);
    if (::bind(lfd_, (sockaddr*)&addr, sizeof addr) < 0) {
        perror("bind");
        return false;
    }
    if (::listen(lfd_, SOMAXCONN) < 0) {
        perror("listen");
        return false;
    }
    return true;
}

void Server::onAccept() {
    // 监听 fd 是边缘触发, 必须一直 accept 到 EAGAIN
    for (;;) {
        sockaddr_storage ss{};
        socklen_t len = sizeof ss;
        int fd = ::accept4(lfd_, (sockaddr*)&ss, &len, SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (fd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return;
            if (errno == EINTR) continue;
            if (errno == EMFILE || errno == ENFILE) {
                std::fprintf(stderr, "[srv] out of file descriptors, accept paused\n");
                return;  // 等下一轮可读事件再试
            }
            perror("accept4");
            return;
        }

        const int one = 1;
        ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);

        const size_t w = rr_.fetch_add(1) % (size_t)nworkers_;
        pool_.at(w)->runInLoop([this, w, fd, peer = formatPeer(ss)] { onNewConn(w, fd, peer); });
    }
}

void Server::onNewConn(size_t w, int fd, std::string peer) {
    if (!running_) {
        ::close(fd);
        return;
    }

    auto c = std::make_shared<Connection>();
    c->fd = fd;
    c->peer = std::move(peer);
    c->worker = w;
    c->owner = this;
    c->loop = pool_.at(w);
    conns_[w][fd] = c;

    // lambda 按值持有 shared_ptr: 回调执行期间连接对象不会被 conns_ 的 erase 销毁
    const bool ok = c->loop->add(fd, EPOLLIN | EPOLLET, [this, w, c](uint32_t ev) {
        if (ev & EPOLLIN) onReadable(w, c);
        if (!c->closed && (ev & (EPOLLERR | EPOLLHUP))) {
            doClose(w, c);
            return;
        }
        if (!c->closed && (ev & EPOLLOUT)) onWritable(w, c);
    });
    if (!ok) {
        doClose(w, c);
        return;
    }

    onConnect(*c);
}

void Server::onReadable(size_t w, const std::shared_ptr<Connection>& c) {
    char buf[kReadChunk];
    for (;;) {
        ssize_t n = ::read(c->fd, buf, sizeof buf);
        if (n > 0) {
            // 交给业务层: 分帧 / 解协议 / 房间与媒体转发都在 onMessage 里
            onMessage(*c, buf, (size_t)n);
            if (c->closed) return;
            continue;  // 边缘触发, 读到 EAGAIN 为止
        }
        if (n == 0) {  // 对端关闭
            doClose(w, c);
            return;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        doClose(w, c);
        return;
    }
}

void Server::onWritable(size_t w, const std::shared_ptr<Connection>& c) {
    // ponytail: erase(0,n) 会搬移剩余数据, 单连接积压大时改成读偏移
    while (!c->out.empty()) {
        ssize_t n = ::write(c->fd, c->out.data(), c->out.size());
        if (n > 0) {
            c->out.erase(0, (size_t)n);
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;  // 等 EPOLLOUT
        doClose(w, c);
        return;
    }
    // 请求过"回完就关": 现在才真的能关
    if (c->out.empty() && c->closeAfterFlush) {
        doClose(w, c);
        return;
    }
    if (!c->closed) updateEvents(c);
}

void Server::sendOn(Connection& c, const char* data, size_t len) {
    if (c.closed || len == 0) return;

    c.out.append(data, len);
    if (c.out.size() > kMaxOutBuf) {
        std::fprintf(stderr, "[srv] %s send buffer overflow, dropping connection\n", c.peer.c_str());
        doClose(c.worker, c.shared_from_this());
        return;
    }
    onWritable(c.worker, c.shared_from_this());  // 先直接写, 写不完挂 EPOLLOUT
}

void Server::closeConn(Connection& c) { doClose(c.worker, c.shared_from_this()); }

void Server::updateEvents(const std::shared_ptr<Connection>& c) {
    uint32_t ev = EPOLLIN | EPOLLET;
    if (!c->out.empty()) ev |= EPOLLOUT;
    c->loop->mod(c->fd, ev);
}

void Server::doClose(size_t w, const std::shared_ptr<Connection>& c) {
    if (c->closed) return;
    c->closed = true;

    const int fd = c->fd;  // erase 要用原始 fd 当 key, 最后才置 -1
    if (c->loop) c->loop->del(fd);
    if (fd >= 0) ::close(fd);

    onClose(*c);  // 业务清理; 此时 fd 已关闭, 不要再 send
    conns_[w].erase(fd);
    c->fd = -1;
}

void Server::onSignal() {
    signalfd_siginfo si{};
    while (::read(sigfd_, &si, sizeof si) == (ssize_t)sizeof si) {
        std::fprintf(stderr, "\n[srv] caught signal %u, shutting down\n", si.ssi_signo);
        stop();
    }
}
