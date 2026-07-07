export const config = {
  api: {
    bodyParser: false
  }
};

const BACKEND_ORIGIN =
  process.env.SYNC_BACKEND_ORIGIN ||
  process.env.NEXT_PUBLIC_SYNC_BACKEND_ORIGIN ||
  "https://syncstream-backend-vosk.onrender.com";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  const path = Array.isArray(req.query.path) ? req.query.path.join("/") : "";
  const target = new URL(`/${path}`, BACKEND_ORIGIN);

  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path") continue;
    if (Array.isArray(value)) {
      for (const item of value) target.searchParams.append(key, item);
    } else if (value != null) {
      target.searchParams.set(key, value);
    }
  }

  const headers = {};
  for (const name of ["content-type", "accept"]) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }

  try {
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");

    if (contentType) res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-store");
    res.status(upstream.status).send(buffer);
  } catch (error) {
    res.status(502).json({
      status: "error",
      message: "Sync backend proxy failed",
      detail: error?.message || "Unknown error"
    });
  }
}
