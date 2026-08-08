// Cloudflare Worker — serves the static site and handles POST /api/contact
//
// Required secrets/variables (Settings -> Variables and Secrets):
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

async function handleContact(request, env) {
  const missing = ["TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "MAIL_TO", "MAIL_FROM"]
    .filter((key) => !env[key]);
  if (missing.length) {
    console.error("Missing environment variables:", missing.join(", "));
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

  const sent = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [env.MAIL_TO],
      reply_to: email,
      subject: `Domain enquiry from ${name}`,
      text
    })
  });

  if (!sent.ok) {
    console.error("Resend rejected the message:", sent.status, await sent.text());
    return json({ error: "That didn't send. Try again in a moment." }, 502);
  }

  return json({ ok: true }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return json({ error: "Use POST." }, 405);
      }
      return handleContact(request, env);
    }

    // Everything else falls through to the static site in ./public
    return env.ASSETS.fetch(request);
  }
};
