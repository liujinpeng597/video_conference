// 线程池: N 个线程, 每个线程跑一个 EventLoop(epoll)。
// 连接按 round-robin 分给某个 loop, 之后这条连接的所有读写都只在那个线程里发生,
// 所以连接表不需要加锁。要在线程池里跑别的活, 用 next()->runInLoop(...)。
#pragma once

#include <atomic>
#include <cstddef>
#include <memory>
#include <thread>
#include <vector>

#include "reactor.h"

class ThreadPool {
public:
    explicit ThreadPool(int n);  // n <= 0 时取 CPU 核数
    ~ThreadPool();
    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    bool start();
    void stop();

    size_t size() const { return loops_.size(); }
    EventLoop* at(size_t i) { return loops_[i].get(); }
    EventLoop* next();  // round-robin 取下一个 loop

private:
    int n_;
    std::vector<std::unique_ptr<EventLoop>> loops_;
    std::vector<std::thread> threads_;
    std::atomic<size_t> rr_{0};
    std::atomic<bool> started_{false};
};
