module.exports = {
  // 推荐正式接入自己的 API / 云函数，避免小程序直接持有数据库 key。
  apiBase: 'http://192.168.3.54:8787',
  supabaseUrl: 'http://192.168.3.54:8787',
  localApiHosts: [
    'http://192.168.3.54:8787',
    'http://127.0.0.1:8787',
    'http://localhost:8787'
  ],
  requestTimeoutMs: 5000,
  supabaseAnonKey: 'sb_publishable_atXq0SmWEiEY6UMouG4dLw_ouXN2U6B',

  // 开发者工具里无后端 code2session 时使用；正式版必须移除。
  devOpenid: 'dev-openid-xiaopingu',

  // 本地演示咨询师账号，用于让小程序提交后直接进入咨询师工作台的匹配申请列表。
  localDemoCounselorId: '00000000-0000-4000-8000-000000000001',
  localDemoCounselorName: '本地演示咨询师'
};
