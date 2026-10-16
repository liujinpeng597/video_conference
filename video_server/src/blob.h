// 录制视频的字节存哪儿 —— 抹平"对象存储 vs 本地目录"的差别。
//
// 为什么要有这一层: 录制的字节不该进 PostgreSQL (会让唯一丢不起的那份数据跟着变重),
// 也不该落在后端容器本地 (三个副本都是无状态的, 存本地等于"哪台录的就丢在哪台")。
// 生产形态是对象存储 (MinIO, S3 兼容); 但本机 / 内网 / 单机部署用目录更省事 ——
// 所以同一套接口两种实现, 用 RECORDINGS_BACKEND 选。
//
// 环境变量:
//   RECORDINGS_BACKEND = file | s3   (默认 file)
//   RECORD_DIR         = 目录 (file 后端, 默认 /data/recordings)
//   S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY / S3_REGION (s3 后端)
//   RECORD_MAX_BYTES   = 单人单次上限 (默认 200MB)
#pragma once

#include <string>

namespace blob {

struct Config {
    bool ok = false;            // 配置齐不齐 (不齐时接口回 503 并说清原因)
    std::string backend;        // "file" | "s3"
    std::string problem;        // 不齐的原因 (给人看的一句话)
};

// 进程启动时调一次 (读环境变量, 需要的话建目录)。
Config init();

// 给 /api/health 和日志用
const char* backendName();
bool ready();
const std::string& problem();
long long maxBytes();           // 单人单次上限

// 存 / 取 / 删。key 由调用方生成 (用户名 + 随机串 + 后缀), 只允许 [A-Za-z0-9_.-]。
bool put(const std::string& key, const std::string& bytes, std::string* err);
bool get(const std::string& key, std::string* out, std::string* err);
bool remove(const std::string& key, std::string* err);

}  // namespace blob
