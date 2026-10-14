CXX      ?= g++
# _GNU_SOURCE: accept4 / SOCK_NONBLOCK / EPOLL_CLOEXEC / signalfd 都是 glibc 的 GNU 扩展,
# 用 -std=c++17 时默认不开, 必须自己定义。
CXXFLAGS ?= -std=c++17 -D_GNU_SOURCE -O2 -g -Wall -Wextra -pthread -MMD -MP

# libpq 的头文件在 Debian/Ubuntu 上放在 /usr/include/postgresql, 光写 -lpq 会找不到头,
# 所以问 pkg-config 要 (libpq-dev 和 libsodium-dev 都会装 .pc 文件)。
# 没有 pkg-config 就退回裸库名, 这样在头文件位置标准的发行版上也能编。
PQ_CFLAGS   := $(shell pkg-config --cflags libpq 2>/dev/null)
PQ_LIBS     := $(shell pkg-config --libs libpq 2>/dev/null || echo -lpq)
SODIUM_LIBS := $(shell pkg-config --libs libsodium 2>/dev/null || echo -lsodium)
# hiredis 没有 .pc 文件, 而且头文件就在 /usr/include/hiredis, 直接给库名就行
HIREDIS_LIBS := -lhiredis
# TURN 临时凭证的 HMAC-SHA1 用 OpenSSL 实现 (libsodium 不导出 SHA-1)
CRYPTO_LIBS  := -lcrypto
# 事件流 (Kafka): 生产者编进主二进制; 消费者是另一个独立小二进制
RDKAFKA_LIBS := $(shell pkg-config --libs rdkafka 2>/dev/null || echo -lrdkafka)

# 用单独的变量, 这样在命令行上传 CXXFLAGS=... 也不会把 pkg-config 的结果挤掉
ALL_CXXFLAGS := $(CXXFLAGS) $(PQ_CFLAGS)
LDLIBS       := $(PQ_LIBS) $(SODIUM_LIBS) $(HIREDIS_LIBS) $(CRYPTO_LIBS) $(RDKAFKA_LIBS)

SRC      := $(wildcard src/*.cpp)
OBJ      := $(SRC:.cpp=.o)
DEP      := $(OBJ:.o=.d)
BIN      := video_server
# 事件流消费者 (只依赖 librdkafka, 不依赖 pq/sodium/hiredis)
CONSUMER_BIN := event_consumer

# 单测: json.* 和 turncred.* 各编一个可执行文件 (都不依赖数据库和 Redis)
TEST_BINS := json_test turncred_test

all: $(BIN) $(CONSUMER_BIN)

$(BIN): $(OBJ)
	$(CXX) $(ALL_CXXFLAGS) -o $@ $^ $(LDLIBS)

$(CONSUMER_BIN): consumer/consumer.cpp
	$(CXX) $(CXXFLAGS) -o $@ $< $(RDKAFKA_LIBS)

%.o: %.cpp
	$(CXX) $(ALL_CXXFLAGS) -c $< -o $@

json_test: test/json_test.cpp src/json.cpp src/json.h
	$(CXX) $(ALL_CXXFLAGS) -o $@ test/json_test.cpp src/json.cpp

turncred_test: test/turncred_test.cpp src/turncred.cpp src/turncred.h
	$(CXX) $(ALL_CXXFLAGS) -o $@ test/turncred_test.cpp src/turncred.cpp $(CRYPTO_LIBS)

test: $(TEST_BINS)
	./json_test
	./turncred_test

clean:
	rm -f $(OBJ) $(DEP) $(BIN) $(CONSUMER_BIN) $(TEST_BINS) test/*.d

-include $(DEP)

.PHONY: all test clean
