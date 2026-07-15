import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://ts051.github.io",
  "http://127.0.0.1:4181",
  "http://localhost:4181"
]);

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const sessionSecret = Deno.env.get("ADMIN_SESSION_SECRET") ?? "";
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

type PlaceInput = {
  id?: string;
  lat: number;
  lng: number;
  name: string;
  showName: boolean;
  radius: number;
  memo: string;
};

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
  if (!serviceRoleKey || !sessionSecret) return json({ error: "Server configuration is incomplete" }, 500, cors);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400, cors);
  }

  try {
    switch (body.action) {
      case "list":
        return await listPlaces(cors);
      case "login":
        return await login(request, String(body.password ?? ""), cors);
      case "create":
        return await mutatePlace(request, "create", body.place, cors);
      case "update":
        return await mutatePlace(request, "update", body.place, cors);
      case "delete":
        return await deletePlace(request, String(body.id ?? ""), cors);
      case "clear":
        return await clearPlaces(request, cors);
      case "changePassword":
        return await changePassword(request, String(body.newPassword ?? ""), cors);
      default:
        return json({ error: "Unknown action" }, 400, cors);
    }
  } catch (error) {
    console.error(error);
    return json({ error: "Server processing failed" }, 500, cors);
  }
});

async function listPlaces(cors: HeadersInit) {
  const { data, error } = await supabase
    .from("radius_note_places")
    .select("id,lat,lng,name,show_name,radius,memo,created_at,updated_at")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return json({ places: (data ?? []).map(toClientPlace) }, 200, cors);
}

async function login(request: Request, password: string, cors: HeadersInit) {
  const clientKey = clientIdentifier(request);
  const blocked = await isLoginBlocked(clientKey);
  if (blocked) return json({ error: "試行回数が多すぎます。15分後に再試行してください。" }, 429, cors);

  const { data, error } = await supabase.rpc("radius_note_verify_password", { candidate: password });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.valid) {
    await recordLoginFailure(clientKey);
    return json({ error: "パスワードが違います。" }, 401, cors);
  }

  await supabase.from("radius_note_login_attempts").delete().eq("client_key", clientKey);
  return json({ token: await issueToken(Number(result.version)) }, 200, cors);
}

async function mutatePlace(request: Request, action: "create" | "update", rawPlace: unknown, cors: HeadersInit) {
  const auth = await authorize(request);
  if (!auth.valid) return json({ error: "管理セッションが無効です。" }, 401, cors);
  const place = validatePlace(rawPlace, action === "update");
  if (!place) return json({ error: "地点データが正しくありません。" }, 400, cors);
  const record = {
    lat: place.lat,
    lng: place.lng,
    name: place.name,
    show_name: place.showName,
    radius: place.radius,
    memo: place.memo,
    updated_at: new Date().toISOString()
  };

  const query = action === "create"
    ? supabase.from("radius_note_places").insert(record)
    : supabase.from("radius_note_places").update(record).eq("id", place.id);
  const { data, error } = await query.select("id,lat,lng,name,show_name,radius,memo,created_at,updated_at").single();
  if (error) throw error;
  return json({ place: toClientPlace(data) }, 200, cors);
}

async function deletePlace(request: Request, id: string, cors: HeadersInit) {
  const auth = await authorize(request);
  if (!auth.valid) return json({ error: "管理セッションが無効です。" }, 401, cors);
  if (!isUuid(id)) return json({ error: "地点IDが正しくありません。" }, 400, cors);
  const { error } = await supabase.from("radius_note_places").delete().eq("id", id);
  if (error) throw error;
  return json({ ok: true }, 200, cors);
}

async function clearPlaces(request: Request, cors: HeadersInit) {
  const auth = await authorize(request);
  if (!auth.valid) return json({ error: "管理セッションが無効です。" }, 401, cors);
  const { error } = await supabase.from("radius_note_places").delete().not("id", "is", null);
  if (error) throw error;
  return json({ ok: true }, 200, cors);
}

async function changePassword(request: Request, newPassword: string, cors: HeadersInit) {
  const auth = await authorize(request);
  if (!auth.valid) return json({ error: "管理セッションが無効です。" }, 401, cors);
  if (newPassword.length < 4 || newPassword.length > 128) {
    return json({ error: "パスワードは4〜128文字で入力してください。" }, 400, cors);
  }
  const { data, error } = await supabase.rpc("radius_note_change_password", { new_password: newPassword });
  if (error) throw error;
  return json({ token: await issueToken(Number(data)) }, 200, cors);
}

async function authorize(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  const token = value.startsWith("Bearer ") ? value.slice(7) : "";
  const payload = await verifyToken(token);
  if (!payload) return { valid: false };
  const { data, error } = await supabase
    .from("radius_note_settings")
    .select("auth_version")
    .eq("singleton", true)
    .single();
  return { valid: !error && Number(data?.auth_version) === payload.version };
}

async function issueToken(version: number) {
  const payload = base64UrlEncode(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000, version }));
  return `${payload}.${await sign(payload)}`;
}

async function verifyToken(token: string): Promise<{ exp: number; version: number } | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !constantTimeEqual(signature, await sign(payload))) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(payload));
    if (!Number.isFinite(parsed.exp) || parsed.exp < Date.now() || !Number.isInteger(parsed.version)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function sign(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function validatePlace(value: unknown, requireId: boolean): PlaceInput | null {
  if (!value || typeof value !== "object") return null;
  const place = value as Record<string, unknown>;
  const id = typeof place.id === "string" ? place.id : undefined;
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  const radius = Number(place.radius);
  const name = String(place.name ?? "").trim();
  const memo = String(place.memo ?? "").trim();
  if (requireId && (!id || !isUuid(id))) return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (!Number.isInteger(radius) || radius < 10 || radius > 50000) return null;
  if (!name || name.length > 60 || memo.length > 200 || typeof place.showName !== "boolean") return null;
  return { id, lat, lng, name, showName: place.showName, radius, memo };
}

async function isLoginBlocked(clientKey: string) {
  const { data } = await supabase
    .from("radius_note_login_attempts")
    .select("blocked_until")
    .eq("client_key", clientKey)
    .maybeSingle();
  return data?.blocked_until ? new Date(data.blocked_until).getTime() > Date.now() : false;
}

async function recordLoginFailure(clientKey: string) {
  const { data } = await supabase
    .from("radius_note_login_attempts")
    .select("failures")
    .eq("client_key", clientKey)
    .maybeSingle();
  const failures = Number(data?.failures ?? 0) + 1;
  await supabase.from("radius_note_login_attempts").upsert({
    client_key: clientKey,
    failures: failures >= 5 ? 0 : failures,
    blocked_until: failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
    updated_at: new Date().toISOString()
  });
}

function clientIdentifier(request: Request) {
  return (request.headers.get("x-forwarded-for") ?? request.headers.get("cf-connecting-ip") ?? "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 120);
}

function toClientPlace(place: Record<string, unknown>) {
  return {
    id: place.id,
    lat: place.lat,
    lng: place.lng,
    name: place.name,
    showName: place.show_name,
    radius: place.radius,
    memo: place.memo,
    createdAt: place.created_at,
    updatedAt: place.updated_at
  };
}

function corsHeaders(origin: string) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin"
  };
  if (allowedOrigins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: unknown, status: number, headers: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function base64UrlEncode(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
