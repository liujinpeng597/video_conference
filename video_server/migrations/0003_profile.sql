-- 个人资料: 昵称 (显示名, 房间列表里用它) + 头像。
--
-- 头像直接存 base64 文本 (data URL 去掉前缀那段), 不引对象存储/上传服务:
-- 前端用 <input type=file> + canvas 压到 128x128 再 base64 上来, 后端存文本、原样发回去。
-- 上限 96KB, 一张 128x128 JPEG 远小于这个数。
-- avatar_ver 是"头像版本"(epoch 秒, 换头像时 +1), 房间成员表里带上它做图片缓存指纹。
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT   NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar       TEXT   NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_ver   BIGINT NOT NULL DEFAULT 0;
