// 事件循环: 一个线程一个 EventLoop, 每个 loop 独占一个 epoll 实例。
// 跨线程投递用 runInLoop(), 通过 eventfd 唤醒, 不用锁保护 fd 集合。
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

// 回调参数是 epoll 的就绪事件位: EPOLLIN / EPOLLOUT / EPOLLERR / EPOLLHUP ...
using EventCallback = std::function<void(uint32_t)>;

class EventLoop {
public:
    EventLoop() = default;
    ~EventLoop();
    EventLoop(const EventLoop&) = delete;
    EventLoop& operator=(const EventLoop&) = delete;

    bool init();

    // 下面三个只在本 loop 线程内调用 (即 loop() 所在的线程)
    bool add(int fd, uint32_t events, EventCallback cb);
    bool mod(int fd, uint32_t events);
    void del(int fd);

    // 线程安全: 把任务丢到 loop 线程执行
    void runInLoop(std::function<void()> fn);

    void loop();  // 阻塞运行, 直到 stop()
    void stop();

    bool inLoopThread() const { return std::this_thread::get_id() == tid_; }

private:
    void drainPending();

    int epfd_ = -1;
    int wakefd_ = -1;
    std::thread::id tid_{};
    std::atomic<bool> running_{false};
    std::mutex mtx_;
    std::vector<std::function<void()>> pending_;
    std::unordered_map<int, EventCallback> cbs_;
};
