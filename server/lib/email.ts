// Sends through Resend's HTTP API. Swap the body of sendEmail for any provider, nothing else changes.
// Without RESEND_API_KEY it logs the message in development and refuses to run in production.
interface Email {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmail(email: Email): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") throw new Error("RESEND_API_KEY is not set");
    console.log(`[DEV EMAIL] to=${email.to} subject=${email.subject}\n${email.text}`);
    return;
  }
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error("EMAIL_FROM is not set");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status})`);
}
