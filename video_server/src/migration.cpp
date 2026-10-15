#include "migration.h"

#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "db.h"
#include "log.h"

namespace migration {
namespace {

// 列出 dir 下所有 .sql 文件, 按文件名排序返回
bool listSqlFiles(const std::string& dir, std::vector<std::string>* out, std::string* err) {
    DIR* d = opendir(dir.c_str());
    if (d == nullptr) {
        *err = "打开迁移目录失败: " + dir;
        return false;
    }
    while (struct dirent* e = readdir(d)) {
        const std::string name = e->d_name;
        if (name.size() > 4 && name.substr(name.size() - 4) == ".sql") {
            out->push_back(name);
        }
    }
    closedir(d);
    std::sort(out->begin(), out->end());
    return true;
}

// 读文件全部内容
bool readFile(const std::string& path, std::string* out, std::string* err) {
    std::ifstream f(path);
    if (!f.is_open()) {
        *err = "打开迁移文件失败: " + path;
        return false;
    }
    std::stringstream ss;
    ss << f.rdbuf();
    *out = ss.str();
    return true;
}

// 查某个迁移是否已执行
bool isApplied(const std::string& name, bool* out, std::string* err) {
    std::string got;
    if (!db::queryScalar("SELECT name FROM schema_migrations WHERE name = $1", {name}, &got, err)) {
        return false;
    }
    *out = !got.empty();  // 迁移文件名不会为空, 所以空串 = 没查到 = 没执行过
    return true;
}

// 记录迁移已执行
bool markApplied(const std::string& name, std::string* err) {
    // applied_at 有 DEFAULT now(), 不用显式给
    return db::execParams("INSERT INTO schema_migrations (name) VALUES ($1)", {name}, err);
}

}  // namespace

bool run(const std::string& migrations_dir, std::string* err) {
    // 1. 建 schema_migrations 表 (幂等)
    const char* createTable = R"SQL(
CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
)SQL";
    if (!db::execStatement(createTable, err)) {
        *err = "建 schema_migrations 表失败: " + *err;
        return false;
    }

    // 2. 列出所有 .sql 文件
    std::vector<std::string> files;
    if (!listSqlFiles(migrations_dir, &files, err)) return false;
    if (files.empty()) {
        logmsg("[migration] 迁移目录为空: %s\n", migrations_dir.c_str());
        return true;
    }

    // 3. 逐个执行
    for (const std::string& name : files) {
        bool applied = false;
        if (!isApplied(name, &applied, err)) {
            *err = "查迁移状态失败 (" + name + "): " + *err;
            return false;
        }
        if (applied) {
            logmsg("[migration] 跳过已执行: %s\n", name.c_str());
            continue;
        }

        // 读文件
        std::string sql;
        const std::string path = migrations_dir + "/" + name;
        if (!readFile(path, &sql, err)) return false;

        // 执行 SQL (整个文件当一条语句)
        logmsg("[migration] 执行: %s\n", name.c_str());
        if (!db::execStatement(sql, err)) {
            *err = "执行迁移失败 (" + name + "): " + *err;
            return false;
        }

        // 记录已执行
        if (!markApplied(name, err)) {
            *err = "记录迁移状态失败 (" + name + "): " + *err;
            return false;
        }
    }

    logmsg("[migration] 全部完成, 共 %zu 个文件\n", files.size());
    return true;
}

}  // namespace migration
