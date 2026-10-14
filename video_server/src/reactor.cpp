#include "reactor.h"

#include <errno.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <unistd.h>

#include <cstdio>
#include <utility>

EventLoop::~EventLoop() {
    if (wakefd_ >= 0) ::close(wakefd_);
    if (epfd_ >= 0) ::close(epfd_);
}

bool EventLoop::init() {
    epfd_ = ::epoll_create1(EPOLL_CLOEXEC);
    if (epfd_ < 0) {
        perror("epoll_create1");
        return false;
    }
    wakefd_ = ::eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (wakefd_ < 0) {
        perror("eventfd");
        return false;
    }
    epoll_event ev{};
    ev.events = EPOLLIN;  // 唤醒用的 fd 用水平触发, 语义最简单
    ev.data.fd = wakefd_;
    if (::epoll_ctl(epfd_, EPOLL_CTL_ADD, wakefd_, &ev) < 0) {
        perror("epoll_ctl(wakefd)");
        return false;
    }
    return true;
}

bool EventLoop::add(int fd, uint32_t events, EventCallback cb) {
    epoll_event ev{};
    ev.events = events;
    ev.data.fd = fd;
    if (::epoll_ctl(epfd_, EPOLL_CTL_ADD, fd, &ev) < 0) {
        perror("epoll_ctl(ADD)");
        return false;
    }
    cbs_[fd] = std::move(cb);
    return true;
}

bool EventLoop::mod(int fd, uint32_t events) {
    epoll_event ev{};
    ev.events = events;
    ev.data.fd = fd;
    if (::epoll_ctl(epfd_, EPOLL_CTL_MOD, fd, &ev) < 0) {
        perror("epoll_ctl(MOD)");
        return false;
    }
    return true;
}

void EventLoop::del(int fd) {
    ::epoll_ctl(epfd_, EPOLL_CTL_DEL, fd, nullptr);
    cbs_.erase(fd);
}

void EventLoop::runInLoop(std::function<void()> fn) {
    {
        std::lock_guard<std::mutex> lk(mtx_);
        pending_.push_back(std::move(fn));
    }
    const uint64_t one = 1;
    ssize_t n = ::write(wakefd_, &one, sizeof(one));
    (void)n;
}

void EventLoop::loop() {
    tid_ = std::this_thread::get_id();
    running_ = true;

    constexpr int kMaxEvents = 256;
    epoll_event evs[kMaxEvents];
    while (running_) {
        int n = ::epoll_wait(epfd_, evs, kMaxEvents, -1);
        if (n < 0) {
            if (errno == EINTR) continue;
            perror("epoll_wait");
            break;
        }
        for (int i = 0; i < n; ++i) {
            const int fd = evs[i].data.fd;
            if (fd == wakefd_) {
                drainPending();
                continue;
            }
            auto it = cbs_.find(fd);
            if (it == cbs_.end()) continue;
            // 必须拷贝: 回调内部可能 del(fd), 那样 it 指向的 std::function 会被销毁
            EventCallback cb = it->second;
            cb(evs[i].events);
        }
    }
}

void EventLoop::drainPending() {
    uint64_t v = 0;
    while (::read(wakefd_, &v, sizeof(v)) > 0) {
    }

    std::vector<std::function<void()>> tasks;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        tasks.swap(pending_);
    }
    for (auto& t : tasks) t();
}

void EventLoop::stop() {
    running_ = false;
    runInLoop([] {});  // 唤醒阻塞中的 epoll_wait
}
