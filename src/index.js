// Cloudflare Worker — serves the static site and handles POST /api/contact
//
// Required secrets (Settings -> Variables and Secrets, runtime section):
//   TURNSTILE_SECRET_KEY  secret key from the Turnstile widget
//   RESEND_API_KEY        API key from resend.com
//   MAIL_TO               where enquiries land, e.g. you@example.com
//   MAIL_FROM             a verified sender, e.g. "Domain enquiry <noreply@privatechef.co.nz>"

const LIMITS = { name: 120, email: 180, message: 4000 };

function json(body, statusCode) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" }
  });
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function passedTurnstile(token, ip, secret) {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);

  const verify = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body }
  );
  const outcome = await verify.json();
  if (!outcome.success) {
    console.error("Turnstile rejected the token:", outcome["error-codes"]);
  }
  return outcome.success === true;
}

// Runs in the background via ctx.waitUntil, so the visitor never waits on it.
// Tries twice, then logs the whole enquiry so nothing is silently lost.
async function sendEnquiry(env, payload) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const sent = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (sent.ok) return;

      console.error(
        `Resend rejected the message (attempt ${attempt}):`,
        sent.status,
        await sent.text()
      );
    } catch (error) {
      console.error(`Resend request failed (attempt ${attempt}):`, error.message);
    }

    if (attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  console.error("ENQUIRY NOT DELIVERED — recover it from here:", JSON.stringify(payload));
}

async function handleContact(request, env, ctx) {
  const missing = ["TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "MAIL_TO", "MAIL_FROM"]
    .filter((key) => !env[key]);
  if (missing.length) {
    console.error("Missing environment variables:", missing.join(", "));
    return json({ error: "That didn't send. Try again in a moment." }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "That didn't send. Try again in a moment." }, 400);
  }

  // Honeypot: real people never fill this in.
  if (clean(form.get("website"), 200)) {
    return json({ ok: true }, 200); // Look successful, send nothing.
  }

  const name = clean(form.get("name"), LIMITS.name);
  const email = clean(form.get("email"), LIMITS.email);
  const message = clean(form.get("message"), LIMITS.message);

  if (!name || !email || !message) {
    return json({ error: "Fill in your name, email, and a message." }, 400);
  }
  if (!looksLikeEmail(email)) {
    return json({ error: "Check the email address — it doesn't look right." }, 400);
  }

  const token = clean(form.get("cf-turnstile-response"), 2048);
  if (!token) {
    return json({ error: "Verification hasn't finished. Wait a moment, then send again." }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const verified = await passedTurnstile(token, ip, env.TURNSTILE_SECRET_KEY);
  if (!verified) {
    return json({ error: "Verification failed. Reload the page and try again." }, 403);
  }

  const country = request.headers.get("CF-IPCountry") || "unknown";
  const text = [
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Country: ${country}`,
    `IP:      ${ip}`,
    "",
    message
  ].join("\n");

  // Hand the send to the runtime and answer the visitor straight away.
  // The Worker stays alive until this settles; failures land in the logs.
  ctx.waitUntil(
    sendEnquiry(env, {
      from: env.MAIL_FROM,
      to: [env.MAIL_TO],
      reply_to: email,
      subject: `Domain enquiry from ${name}`,
      text
    })
  );

  return json({ ok: true }, 200);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return json({ error: "Use POST." }, 405);
      }
      return handleContact(request, env, ctx);
    }

    // Everything else falls through to the static site in ./public
    return env.ASSETS.fetch(request);
  }
};
