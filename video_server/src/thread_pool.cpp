#include "thread_pool.h"

#include <cstdio>

ThreadPool::ThreadPool(int n) : n_(n) {
    if (n_ <= 0) {
        n_ = (int)std::thread::hardware_concurrency();
        if (n_ <= 0) n_ = 4;
    }
}

ThreadPool::~ThreadPool() { stop(); }

bool ThreadPool::start() {
    if (started_.exchange(true)) return true;

    loops_.resize((size_t)n_);
    for (auto& lp : loops_) {
        lp = std::make_unique<EventLoop>();
        if (!lp->init()) {
            std::fprintf(stderr, "thread pool: event loop init failed\n");
            return false;
        }
    }
    threads_.reserve((size_t)n_);
    for (auto& lp : loops_) {
        EventLoop* loop = lp.get();
        threads_.emplace_back([loop] { loop->loop(); });
    }
    return true;
}

void ThreadPool::stop() {
    if (!started_.exchange(false)) return;

    for (auto& lp : loops_) lp->stop();
    for (auto& t : threads_) {
        if (t.joinable()) t.join();
    }
    threads_.clear();
}

EventLoop* ThreadPool::next() {
    if (loops_.empty()) return nullptr;
    return loops_[rr_.fetch_add(1) % loops_.size()].get();
}
