/**
 * HTTP client for the MWDAT relay server's workflow REST API.
 */
const DEFAULT_URL = "https://relay.simulationapi.com";
function baseUrl() {
    return process.env.MWDAT_RELAY_URL ?? DEFAULT_URL;
}
class ApiError extends Error {
    status;
    body;
    constructor(status, body) {
        super(`API ${status}: ${body.slice(0, 200)}`);
        this.status = status;
        this.body = body;
        this.name = "ApiError";
    }
}
export async function request(method, path, body) {
    const url = `${baseUrl()}${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ApiError(res.status, text);
    }
    return (await res.json());
}
// --- Workflow CRUD ---
export async function listWorkflows() {
    return request("GET", "/workflows");
}
export async function getWorkflow(id) {
    return request("GET", `/workflows/${id}`);
}
export async function createWorkflow(data) {
    return request("POST", "/workflows", data);
}
export async function updateWorkflow(id, data) {
    return request("PUT", `/workflows/${id}`, data);
}
export async function deleteWorkflow(id) {
    return request("DELETE", `/workflows/${id}`);
}
// --- Activation ---
export async function activateWorkflow(workflowId, sessionId, options) {
    const body = {};
    if (sessionId)
        body.sessionId = sessionId;
    if (options?.deviceId)
        body.deviceId = options.deviceId;
    if (options?.override)
        body.override = options.override;
    if (options?.reason)
        body.reason = options.reason;
    const res = await fetch(`${baseUrl()}/workflows/${workflowId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json());
    if (res.status === 409) {
        return { appId: "", status: "conflict", conflict: data.conflict };
    }
    if (!res.ok)
        throw new ApiError(res.status, JSON.stringify(data));
    return data;
}
// --- Node Definitions ---
let nodeDefsCache = null;
let nodeDefsCacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute
export async function getNodeDefinitions(forceRefresh = false) {
    if (!forceRefresh && nodeDefsCache && Date.now() - nodeDefsCacheTime < CACHE_TTL) {
        return nodeDefsCache;
    }
    const defs = await request("GET", "/api/node-definitions");
    nodeDefsCache = defs;
    nodeDefsCacheTime = Date.now();
    return defs;
}
// --- Sessions ---
export async function listSessions() {
    const raw = await request("GET", "/sessions");
    return raw.map((s) => ({
        sessionId: (s.id ?? s.sessionId),
        live: s.live,
        activeWorkflowId: (s.activeWorkflowId ?? null),
        viewerCount: s.viewerCount,
        uptimeMs: s.uptimeMs,
        publisherStandby: s.publisherStandby,
        device: s.metadata
            ? {
                deviceId: s.metadata.deviceId,
                deviceName: s.metadata.deviceName,
                deviceModel: s.metadata.deviceModel,
                wearableType: s.metadata.wearableType,
            }
            : s.device,
    }));
}
// --- Runtime Observability ---
export async function getActiveSessions() {
    return request("GET", "/sessions/active");
}
export async function getNodeStates(sessionId, limit = 100) {
    return request("GET", `/sessions/${sessionId}/node-states?limit=${limit}`);
}
export async function getSessionTelemetry(sessionId) {
    return request("GET", `/sessions/${sessionId}/telemetry`);
}
export async function deactivateWorkflow(sessionId) {
    return request("POST", `/sessions/${sessionId}/deactivate`);
}
//# sourceMappingURL=client.js.map