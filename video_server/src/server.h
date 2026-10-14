// TCP 服务器骨架: 主线程跑 accept loop, 工作线程跑各自的 epoll loop。
// 这里只负责连接的建立/收发/关闭, 业务语义(房间、信令、媒体转发)在 handlers.cpp。
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "reactor.h"
#include "thread_pool.h"

struct Connection : std::enable_shared_from_this<Connection> {
    int fd = -1;
    std::string peer;    // "ip:port"
    std::string in;      // 已收到但还没拼成完整请求的字节 (HTTP 半包/粘包)
    std::string out;     // 待发送缓冲
    bool closed = false; // 已请求关闭
    // 回完 out 里的字节就关 (给 HTTP 的 Connection: close 用)。
    // 和 closed 的区别: closed 是立刻关, 这个会等 onWritable 把缓冲写完。
    bool closeAfterFlush = false;
    size_t worker = 0;   // 归属的线程池下标
    EventLoop* loop = nullptr;
    class Server* owner = nullptr;

    // 业务回调里用: 发送 / 请求关闭。只能在所属 worker 线程里调用。
    // 注意: close() 只是打标记, 真正的 close(fd) 在回调返回后执行。
    void send(const void* data, size_t len);
    void send(const std::string& s) { send(s.data(), s.size()); }
    void close();
};

class Server {
public:
    Server(uint16_t port, int workers);
    ~Server();
    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    bool start();  // 监听 + 起线程池; 失败返回 false
    int run();     // 主线程跑 accept loop, 直到 stop()
    void stop();   // 幂等, 可在信号回调里调

    // 供 handlers 调用 (内部接口)
    void sendOn(Connection& c, const char* data, size_t len);
    void closeConn(Connection& c);

private:
    bool listenOn();
    void onAccept();
    void onNewConn(size_t worker, int fd, std::string peer);
    void onReadable(size_t worker, const std::shared_ptr<Connection>& c);
    void onWritable(size_t worker, const std::shared_ptr<Connection>& c);
    void onSignal();
    void doClose(size_t worker, const std::shared_ptr<Connection>& c);
    void updateEvents(const std::shared_ptr<Connection>& c);

    uint16_t port_;
    int nworkers_;
    int lfd_ = -1;
    int sigfd_ = -1;
    EventLoop acceptLoop_;
    ThreadPool pool_;
    // 每个 worker 一张连接表, 只被对应线程访问 -> 不需要加锁
    std::vector<std::unordered_map<int, std::shared_ptr<Connection>>> conns_;
    std::atomic<size_t> rr_{0};
    std::atomic<bool> running_{false};
    std::atomic<bool> stopped_{false};
};
