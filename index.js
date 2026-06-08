const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
require("dotenv").config();

const url_api = process.env.URL_API?.replace(/\/$/, "");
const url_webhook = process.env.URL_WEBHOOK;
const LAST_NEWS_FILE = "last-news.json";

if (!url_api || !url_webhook) {
    throw new Error("URL_API dan URL_WEBHOOK wajib diisi di Secrets / .env");
}

const getLastSentLink = () => {
    if (!fs.existsSync(LAST_NEWS_FILE)) {
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(LAST_NEWS_FILE, "utf8"));
        return data.lastLink || null;
    } catch {
        return null;
    }
};

const saveLastSentLink = (link) => {
    fs.writeFileSync(
        LAST_NEWS_FILE,
        JSON.stringify(
            {
                lastLink: link,
                updatedAt: new Date().toISOString(),
            },
            null,
            2
        )
    );
};

const normalizeText = (text = "") => {
    return text
        .replace(/\u00a0/g, " ")
        .replace(/\t/g, " ")
        .replace(/[ ]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .split("\n")
        .map((line) => line.replace(/[ ]{2,}/g, " ").trimEnd())
        .join("\n")
        .trim();
};

const parseNode = ($, node) => {
    if (node.type === "text") {
        return node.data || "";
    }

    if (node.type !== "tag") {
        return "";
    }

    const tag = node.name?.toLowerCase();

    if (tag === "br") {
        return "\n";
    }

    if (tag === "img") {
        return "";
    }

    const children = $(node)
        .contents()
        .toArray()
        .map((child) => parseNode($, child))
        .join("");

    if (tag === "p" || tag === "div") {
        const text = normalizeText(children);
        return text ? `${text}\n\n` : "";
    }

    if (tag === "b" || tag === "strong") {
        const text = normalizeText(children);
        return text ? `**${text}**` : "";
    }

    if (tag === "i" || tag === "em") {
        const text = normalizeText(children);
        return text ? `*${text}*` : "";
    }

    if (tag === "li") {
        const text = normalizeText(children);
        return text ? `- ${text}\n` : "";
    }

    if (tag === "a") {
        const text = normalizeText(children);
        const href = $(node).attr("href");

        if (!href) return text;
        return `[${text || href}](${href})`;
    }

    if (tag === "tr") {
        const cells = $(node)
            .children("th, td")
            .toArray()
            .map((cell) => normalizeText(parseNode($, cell)))
            .filter(Boolean);

        return cells.length ? `${cells.join(" : ")}\n` : "";
    }

    if (tag === "table") {
        const rows = $(node)
            .find("tr")
            .toArray()
            .map((row) => parseNode($, row))
            .join("");

        return rows ? `\n${rows}\n` : "";
    }

    return children;
};

const parsingData = (content) => {
    const $ = cheerio.load(content || "", {
        decodeEntities: true,
    });

    const images = [];

    $("img").each((_, el) => {
        const src = $(el).attr("src");

        if (src && !images.includes(src)) {
            images.push(src);
        }
    });

    const text = $.root()
        .contents()
        .toArray()
        .map((node) => parseNode($, node))
        .join("");

    return {
        text: normalizeText(text),
        images,
    };
};

const chunkText = (text, maxLength = 3800) => {
    if (!text) return ["-"];

    const chunks = [];
    const paragraphs = text.split(/\n\n+/);

    let current = "";

    for (const paragraph of paragraphs) {
        if ((current + "\n\n" + paragraph).length <= maxLength) {
            current = current ? `${current}\n\n${paragraph}` : paragraph;
        } else {
            if (current) chunks.push(current);

            if (paragraph.length > maxLength) {
                for (let i = 0; i < paragraph.length; i += maxLength) {
                    chunks.push(paragraph.slice(i, i + maxLength));
                }
                current = "";
            } else {
                current = paragraph;
            }
        }
    }

    if (current) chunks.push(current);

    return chunks;
};

const getLatestURL = async () => {
    const response = await axios.get(url_api);

    const latestNews = Array.isArray(response.data?.data)
        ? response.data.data[0]
        : response.data?.data?.result;

    const latestURL = latestNews?.link;

    if (!latestURL) {
        throw new Error("Link berita terbaru tidak ditemukan dari API list.");
    }

    return latestURL;
};

const getDataNews = async () => {
    const latestURL = await getLatestURL();

    const response = await axios.get(`${url_api}/${latestURL}`);
    // const response = await axios.get(`https://jkt48.com/api/v1/news/pengumuman-mengenai-pre-order-jkt48-digital-photobook-jkt48-personal-meet-and-greet-festival-love-dr`);
    const result = response.data?.data?.result;

    if (!result) {
        throw new Error("Data detail berita tidak ditemukan.");
    }

    return result;
};

const sendWebhook = async (payload) => {
    await axios.post(url_webhook, payload, {
        headers: {
            "Content-Type": "application/json",
        },
    });
};

const sendNewsToDiscord = async (news) => {
    const parsed = parsingData(news.content_body);
    const chunks = chunkText(parsed.text);

    const apiDetailUrl = `https://jkt48.com/news/${news.link}`;

    for (let i = 0; i < chunks.length; i++) {
        const embed = {
            title: i === 0 ? news.title : `${news.title} - Lanjutan ${i + 1}`,
            url: apiDetailUrl,
            description: chunks[i],
            color: 0xe91e63,
            footer: {
                text: "JKT48 News",
            },
            timestamp: news.valid_date_from || new Date().toISOString(),
        };

        if (i === 0 && parsed.images.length > 0) {
            embed.image = {
                url: parsed.images[0],
            };
        }

        await sendWebhook({
            embeds: [embed],
        });
    }

    const remainingImages = parsed.images.slice(1);

    for (const imageUrl of remainingImages) {
        await sendWebhook({
            embeds: [
                {
                    title: "Gambar tambahan",
                    url: imageUrl,
                    image: {
                        url: imageUrl,
                    },
                    color: 0xe91e63,
                },
            ],
        });
    }
};

const main = async () => {
    try {
        const news = await getDataNews();

        const lastSentLink = getLastSentLink();

        if (lastSentLink === news.link) {
            console.log(`Berita sudah pernah dikirim: ${news.title}`);
            return;
        }

        await sendNewsToDiscord(news);

        saveLastSentLink(news.link);

        console.log(`Berhasil mengirim berita: ${news.title}`);
    } catch (error) {
        console.error("Gagal:", error.response?.data || error.message);
        process.exit(1);
    }
};

main();
