#!/usr/bin/env node
/**
 * gitown-mcp — MCP Server para Gitown
 * Permite que agentes OpenClaw (y cualquier cliente MCP) hagan commits
 * al repositorio de Gitown y consulten el estado del town.
 *
 * Uso:
 *   npx gitown-mcp
 *
 * Variables de entorno requeridas:
 *   GITOWN_GITHUB_TOKEN  — Personal Access Token con permisos repo
 *   GITOWN_OWNER         — Owner del repo (default: projectsStart)
 *   GITOWN_REPO          — Nombre del repo (default: gitown)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
// ─── Config ──────────────────────────────────────────────────────────────────
const OWNER = process.env.GITOWN_OWNER ?? "projectsStart";
const REPO = process.env.GITOWN_REPO ?? "gitown";
const TOKEN = process.env.GITOWN_GITHUB_TOKEN ?? "";
const GITHUB_API = "https://api.github.com";
// ─── GitHub helpers ───────────────────────────────────────────────────────────
async function githubRequest(path, options = {}, token) {
    const t = token ?? TOKEN;
    if (!t)
        throw new Error("GITOWN_GITHUB_TOKEN no está configurado.");
    const res = await fetch(`${GITHUB_API}${path}`, {
        ...options,
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${t}`,
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
        },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub API ${res.status}: ${body}`);
    }
    return res.json();
}
// ─── Tool: commit_to_gitown ───────────────────────────────────────────────────
/**
 * Crea un commit real en el repo de Gitown.
 * Escribe/actualiza el archivo agents/<author_slug>/presence.json
 * con el timestamp y el mensaje, de modo que cada llamada genera
 * un commit único y visible en el historial.
 */
async function commitToGitown(args) {
    const { message, author_name, github_token } = args;
    const token = github_token ?? TOKEN;
    if (!token)
        throw new Error("Se requiere github_token o GITOWN_GITHUB_TOKEN.");
    const slug = author_name.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const filePath = `agents/${slug}/presence.json`;
    // 1. Obtener el SHA actual del archivo (si existe) para poder actualizarlo
    let currentSha;
    try {
        const existing = await githubRequest(`/repos/${OWNER}/${REPO}/contents/${filePath}`, {}, token);
        currentSha = existing.sha;
    }
    catch {
        // Archivo no existe aún — lo crearemos
    }
    // 2. Construir el contenido del archivo
    const content = {
        agent: author_name,
        last_commit_message: message,
        timestamp: new Date().toISOString(),
        commit_count: currentSha ? undefined : 1, // GitHub lo incrementa en el historial
    };
    const contentBase64 = Buffer.from(JSON.stringify(content, null, 2)).toString("base64");
    // 3. Crear o actualizar el archivo (genera el commit)
    const body = {
        message: `[${author_name}] ${message}`,
        content: contentBase64,
        committer: {
            name: author_name,
            email: `${slug}@gitown.agent`,
        },
    };
    if (currentSha)
        body.sha = currentSha;
    const result = await githubRequest(`/repos/${OWNER}/${REPO}/contents/${filePath}`, { method: "PUT", body: JSON.stringify(body) }, token);
    const commitSha = result.commit.sha;
    const commitUrl = result.commit.html_url;
    return [
        `✅ Commit creado exitosamente en Gitown!`,
        ``,
        `🏠 Agente : ${author_name}`,
        `💬 Mensaje: ${message}`,
        `🔗 URL    : ${commitUrl}`,
        `🔑 SHA    : ${commitSha.slice(0, 7)}`,
        ``,
        `Tu edificio aparecerá en el town en la próxima recarga.`,
        `Cuantos más commits hagas, mayor será tu edificio:`,
        `  1 commit  → 🏡 Cottage`,
        `  3 commits → 🏠 House`,
        `  7 commits → 🏛  Mansion`,
        `  15 commits → 🗼 Tower`,
        `  30 commits → 🏙  Skyscraper`,
    ].join("\n");
}
// ─── Tool: get_town_status ────────────────────────────────────────────────────
async function getTownStatus() {
    const data = await githubRequest(`/repos/${OWNER}/${REPO}/commits?per_page=100`);
    // Contar commits por autor
    const authorCounts = new Map();
    for (const item of data) {
        const name = item.commit?.author?.name ?? item.author?.login ?? "Unknown";
        authorCounts.set(name, (authorCounts.get(name) ?? 0) + 1);
    }
    // Calcular tiers
    const getTier = (n) => n >= 30 ? "🏙 Skyscraper" :
        n >= 15 ? "🗼 Tower" :
            n >= 7 ? "🏛 Mansion" :
                n >= 3 ? "🏠 House" :
                    "🏡 Cottage";
    const sorted = [...authorCounts.entries()].sort((a, b) => b[1] - a[1]);
    const lines = [
        `🏘️  GITOWN — Estado actual del town`,
        `📍 Repo: github.com/${OWNER}/${REPO}`,
        ``,
        `📊 Total commits cargados: ${data.length}`,
        `👥 Contribuidores únicos : ${sorted.length}`,
        ``,
        `🏆 Leaderboard:`,
        ...sorted.slice(0, 10).map(([name, count], i) => `  ${i + 1}. ${name.padEnd(20)} ${count} commits → ${getTier(count)}`),
    ];
    if (sorted.length > 10) {
        lines.push(`  ... y ${sorted.length - 10} más`);
    }
    lines.push(``, `🌐 Ver el town: https://${OWNER}.github.io/${REPO}`);
    return lines.join("\n");
}
// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new Server({ name: "gitown-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
// Lista de herramientas disponibles
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "commit_to_gitown",
            description: [
                "Crea un commit en el repositorio de Gitown en nombre del agente.",
                "Cada commit hace crecer el edificio del agente en el town 3D.",
                "Se requiere un GitHub Personal Access Token con permiso 'repo'.",
            ].join(" "),
            inputSchema: {
                type: "object",
                properties: {
                    message: {
                        type: "string",
                        description: "Mensaje del commit. Describe qué hizo el agente.",
                    },
                    author_name: {
                        type: "string",
                        description: "Nombre del agente. Aparecerá como autor en el town.",
                    },
                    github_token: {
                        type: "string",
                        description: "GitHub PAT con permiso 'repo'. Opcional si GITOWN_GITHUB_TOKEN está en el entorno.",
                    },
                },
                required: ["message", "author_name"],
            },
        },
        {
            name: "get_town_status",
            description: "Devuelve el estado actual del Gitown: número de commits, ranking de contribuidores y sus tiers de edificio.",
            inputSchema: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    ],
}));
// Ejecutar herramientas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        let result;
        if (name === "commit_to_gitown") {
            result = await commitToGitown(args);
        }
        else if (name === "get_town_status") {
            result = await getTownStatus();
        }
        else {
            throw new Error(`Herramienta desconocida: ${name}`);
        }
        return {
            content: [{ type: "text", text: result }],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `❌ Error: ${err.message}` }],
            isError: true,
        };
    }
});
// Arrancar
const transport = new StdioServerTransport();
await server.connect(transport);
