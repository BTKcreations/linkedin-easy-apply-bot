// Deterministic company verification — zero AI cost.
// Returns { genuine: bool, tier, reasons[] } from LinkedIn company page signals.
export async function verifyCompany(page, companyUrl) {
  const reasons = [];
  try {
    await page.goto(companyUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    const text = await page.locator("body").innerText();
    const fol = text.match(/([\d,]+)\s+followers/)?.[1]?.replace(/,/g, "");
    const followers = fol ? parseInt(fol, 10) : 0;
    const size = text.match(/(\d[\d,]*-?[\d,]*\+?)\s+employees/)?.[1] || "unknown";
    const website = await page.locator("a[href^='http']:not([href*='linkedin.com'])").first().getAttribute("href").catch(() => null);
    if (followers >= 10000) reasons.push(`large-following:${followers}`);
    else if (followers >= 1000) reasons.push(`mid-following:${followers}`);
    else reasons.push(`small-following:${followers}`);
    if (website) reasons.push(`has-website`);
    const genuine = followers >= 300 && !!website;
    const tier = followers >= 50000 ? "top" : followers >= 2000 ? "mid" : "small";
    return { genuine, tier, followers, size, website, reasons };
  } catch (e) {
    return { genuine: false, tier: "unknown", reasons: [`verify-error:${String(e).slice(0, 120)}`], escalate: true };
  }
}
