#include "blob.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <sys/stat.h>
#include <unistd.h>

#include "log.h"

namespace blob {
namespace {

Config g_cfg;
long long g_maxBytes = 200LL * 1024 * 1024;   // 单人单次 200MB

std::string envStr(const char* name, const char* fallback) {
    const char* v = std::getenv(name);
    return (v == nullptr || *v == '\0') ? std::string(fallback) : std::string(v);
}

// 键是应用层生成的, 但仍然当成不可信输入检查: 只允许 [A-Za-z0-9_.-], 且不许出现 ".."。
// 少一个检查, 一个拼错的键就是一次目录穿越写到外面去。
bool keyOk(const std::string& key) {
    if (key.empty() || key.size() > 200) return false;
    if (key.find("..") != std::string::npos) return false;
    for (const char c : key) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                        c == '_' || c == '.' || c == '-';
        if (!ok) return false;
    }
    return true;
}

std::string dirPath(const std::string& key) { return g_cfg.backend == "file" ? (envStr("RECORD_DIR", "/data/recordings") + "/" + key) : std::string(); }

}  // namespace

Config init() {
    g_cfg.backend = envStr("RECORDINGS_BACKEND", "file");
    const char* maxEnv = std::getenv("RECORD_MAX_BYTES");
    if (maxEnv != nullptr && *maxEnv != '\0') {
        const long long n = std::strtoll(maxEnv, nullptr, 10);
        if (n > 0) g_maxBytes = n;
    }

    if (g_cfg.backend == "s3") {
        // 说明白: 这一档的 SigV4 签名还没写 (见 README 的"录制"一节)。配置了但没实现时
        // 一定要报出来, 不能让上传静默地什么都没存。
        g_cfg.ok = false;
        g_cfg.problem = "s3 后端还没实现（先把 RECORDINGS_BACKEND 设成 file，或者等 SigV4 落地）";
        logmsg("[blob] 后端=s3, 但还没实现; 录制上传会明确失败\n");
        return g_cfg;
    }

    const std::string dir = envStr("RECORD_DIR", "/data/recordings");
    struct stat st;
    if (stat(dir.c_str(), &st) != 0) {
        if (mkdir(dir.c_str(), 0755) != 0) {
            g_cfg.ok = false;
            g_cfg.problem = "建不了录制目录 " + dir + ": " + std::strerror(errno);
            logmsg("[blob] %s\n", g_cfg.problem.c_str());
            return g_cfg;
        }
    } else if (!S_ISDIR(st.st_mode)) {
        g_cfg.ok = false;
        g_cfg.problem = dir + " 不是目录";
        logmsg("[blob] %s\n", g_cfg.problem.c_str());
        return g_cfg;
    }
    g_cfg.ok = true;
    logmsg("[blob] 后端=file, 目录=%s, 单次上限=%lldMB\n", dir.c_str(), g_maxBytes / 1024 / 1024);
    return g_cfg;
}

const char* backendName() { return g_cfg.backend.c_str(); }
bool ready() { return g_cfg.ok; }
const std::string& problem() { return g_cfg.problem; }
long long maxBytes() { return g_maxBytes; }

bool put(const std::string& key, const std::string& bytes, std::string* err) {
    err->clear();
    if (!g_cfg.ok) { *err = g_cfg.problem; return false; }
    if (!keyOk(key)) { *err = "非法的对象键"; return false; }
    const std::string path = dirPath(key);
    FILE* f = std::fopen(path.c_str(), "wb");
    if (f == nullptr) { *err = "打不开文件: " + std::string(std::strerror(errno)); return false; }
    const size_t n = std::fwrite(bytes.data(), 1, bytes.size(), f);
    const int closed = std::fclose(f);
    if (n != bytes.size() || closed != 0) {
        std::remove(path.c_str());   // 半截文件不如没有
        *err = "写文件失败";
        return false;
    }
    return true;
}

bool get(const std::string& key, std::string* out, std::string* err) {
    err->clear();
    out->clear();
    if (!g_cfg.ok) { *err = g_cfg.problem; return false; }
    if (!keyOk(key)) { *err = "非法的对象键"; return false; }
    const std::string path = dirPath(key);
    FILE* f = std::fopen(path.c_str(), "rb");
    if (f == nullptr) { *err = "没这个对象"; return false; }
    char buf[64 * 1024];
    size_t n = 0;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out->append(buf, n);
    std::fclose(f);
    return true;
}

bool remove(const std::string& key, std::string* err) {
    err->clear();
    if (!g_cfg.ok) { *err = g_cfg.problem; return false; }
    if (!keyOk(key)) { *err = "非法的对象键"; return false; }
    const std::string path = dirPath(key);
    if (std::remove(path.c_str()) != 0 && errno != ENOENT) {
        *err = "删不掉: " + std::string(std::strerror(errno));
        return false;
    }
    return true;   // 本来就不在也算删成功 (幂等)
}

}  // namespace blob
