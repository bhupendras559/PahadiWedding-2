// Dynamic XML sitemap: always lists published blog posts from Supabase.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://evjzwhqheycsmvmjnclf.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_OUTOekYvhOgwpiYLniSRvA_javLnkuJ";

const STATIC_URLS = [
  "/", "/vendor-register.html", "/booking.html", "/blog.html", "/vendors.html",
  "/ranikhet-wedding-guide.html", "/mukteshwar-wedding-guide.html",
  "/nainital-wedding-guide.html", "/almora-wedding-guide.html",
  "/uttarakhand-wedding-budget-planner.html", "/destination-wedding-kumaon-guide.html",
  "/budget-friendly-pahadi-wedding.html", "/gaon-ki-shaadi-sahayata.html",
  "/one-stop-pahadi-wedding-planning.html", "/venues.html"
];

const escapeXml = (value) => String(value).replace(/[<>&'"]/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
}[c]));

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).end("Method not allowed");
  }
  try {
    const response = await fetch(
      SUPABASE_URL + "/rest/v1/blog_posts?select=slug,updated_at,published_at&status=eq.published&order=published_at.desc&limit=1000",
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY } }
    );
    if (!response.ok) throw new Error("Blog index could not be loaded");
    const posts = await response.json();
    const now = new Date().toISOString().slice(0, 10);
    const urls = STATIC_URLS.map((path) => ({ loc: "https://pahadiwedding.in" + path, lastmod: now }));
    for (const post of posts) {
      if (!post.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug)) continue;
      urls.push({
        loc: "https://pahadiwedding.in/blog/" + encodeURIComponent(post.slug),
        lastmod: (post.updated_at || post.published_at || now).slice(0, 10)
      });
    }
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((u) => '  <url><loc>' + escapeXml(u.loc) + '</loc><lastmod>' +
        escapeXml(u.lastmod) + '</lastmod></url>').join('\n') +
      '\n</urlset>';
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).send(xml);
  } catch (error) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(503).send("Sitemap temporarily unavailable");
  }
};
