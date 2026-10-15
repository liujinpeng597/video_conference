#pragma once

#include <string>

// 数据库迁移机制 (极简版):
//   1. 启动时建 schema_migrations 表 (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)
//   2. 读 migrations/ 目录下所有 .sql 文件, 按文件名排序
//   3. 对每个文件: 查 schema_migrations 有没有这条记录, 没有就执行 SQL 并插入记录
//   4. 全部幂等: 同一个迁移文件跑多次结果一样 (CREATE IF NOT EXISTS 等)
//
// 加新迁移 = 加一个 NNNN_描述.sql 文件, 重启自动跑。
// 回滚 = 切回旧 tag 重启 (旧代码不认识新迁移, 但新表/列留着不碍事)。
namespace migration {

// migrations_dir: 迁移文件所在目录 (绝对路径或相对 cwd)
// 返回 true = 全部成功; false = 有失败, *err 里有原因
bool run(const std::string& migrations_dir, std::string* err);

}  // namespace migration
