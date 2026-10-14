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

# 用单独的变量, 这样在命令行上传 CXXFLAGS=... 也不会把 pkg-config 的结果挤掉
ALL_CXXFLAGS := $(CXXFLAGS) $(PQ_CFLAGS)
LDLIBS       := $(PQ_LIBS) $(SODIUM_LIBS) $(HIREDIS_LIBS)

SRC      := $(wildcard src/*.cpp)
OBJ      := $(SRC:.cpp=.o)
DEP      := $(OBJ:.o=.d)
BIN      := video_server

# json.* 的自测, 不依赖数据库, 单独编一个可执行文件
TEST_BIN := json_test
TEST_SRC := $(wildcard test/*.cpp)

all: $(BIN)

$(BIN): $(OBJ)
	$(CXX) $(ALL_CXXFLAGS) -o $@ $^ $(LDLIBS)

%.o: %.cpp
	$(CXX) $(ALL_CXXFLAGS) -c $< -o $@

$(TEST_BIN): $(TEST_SRC) src/json.cpp src/json.h
	$(CXX) $(ALL_CXXFLAGS) -o $@ $(TEST_SRC) src/json.cpp

test: $(TEST_BIN)
	./$(TEST_BIN)

clean:
	rm -f $(OBJ) $(DEP) $(BIN) $(TEST_BIN) test/*.d

-include $(DEP)

.PHONY: all test clean
