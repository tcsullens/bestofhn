import { runJob, type Env } from "./job.ts";

export default {
  async scheduled(controller, env) {
    await runJob(env, Math.floor(controller.scheduledTime / 1000));
  },

  // Static files in ./public are served before this handler runs; only unmatched paths reach it.
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/data.json") return new Response("Not found", { status: 404 });
    const obj = await env.DATA.get("data.json");
    if (!obj) return new Response("data.json has not been built yet", { status: 503 });
    return new Response(obj.body, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300", etag: obj.httpEtag },
    });
  },
} satisfies ExportedHandler<Env>;
