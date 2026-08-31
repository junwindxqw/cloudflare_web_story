// 邮件发送：Resend（生产）+ 控制台日志（本地开发未配置时的回退）
// 使用 Resend 需配置：RESEND_API_KEY（secret）与 MAIL_FROM（如 "书阁 <noreply@your-domain.com>"）

export function mailerReady(env) {
  return Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
}

function codeEmailHtml(code, purpose) {
  const title = purpose === 'reset' ? '密码重置验证码' : '注册验证码';
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:460px;margin:24px auto;background:#fff;border-radius:16px;padding:32px;text-align:center;">
    <h1 style="font-size:20px;color:#1d2129;margin:0 0 8px;">📚 书阁 · ${title}</h1>
    <p style="color:#5d6673;font-size:14px;margin:0 0 24px;">请使用以下验证码${purpose === 'reset' ? '重置您的密码' : '完成注册'}（10 分钟内有效）：</p>
    <div style="font-size:40px;font-weight:700;letter-spacing:12px;color:#5a63e8;background:#f4f5ff;border-radius:12px;padding:16px 0;margin:0 0 24px;">${code}</div>
    <p style="color:#9aa3b0;font-size:12px;margin:0;">如果这不是您本人的操作，请忽略本邮件。</p>
  </div>
</body></html>`;
}

function codeEmailText(code, purpose) {
  const title = purpose === 'reset' ? '密码重置验证码' : '注册验证码';
  return `【书阁】${title}：${code}（10 分钟内有效）。如果这不是您本人的操作，请忽略本邮件。`;
}

// 发送 4 位数字验证码邮件；未配置 Resend 时打印到 Worker 日志（本地开发用）
export async function sendCodeEmail(env, to, code, purpose) {
  const subject = purpose === 'reset' ? `书阁 · 密码重置验证码 ${code}` : `书阁 · 注册验证码 ${code}`;
  if (!mailerReady(env)) {
    console.log(`[mailer] 未配置 RESEND_API_KEY / MAIL_FROM，验证码直接输出到日志：to=${to} code=${code}`);
    return 'console';
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [to],
      subject,
      html: codeEmailHtml(code, purpose),
      text: codeEmailText(code, purpose),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error('[mailer] Resend 发送失败：', res.status, detail);
    throw new Error('验证码邮件发送失败，请稍后重试');
  }
  return 'resend';
}
