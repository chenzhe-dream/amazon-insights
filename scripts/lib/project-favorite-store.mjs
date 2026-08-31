import fs from "node:fs";
import path from "node:path";

import { getProjectRoot } from "./project-root.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const KINDS = new Set(["analysis", "keyword-compare", "traffic-promo", "checklist"]);

function safeId(value, label) {
  const id = String(value ?? "");
  if (!UUID_V4.test(id)) throw new TypeError(`${label} must be a UUID`);
  return id.toLowerCase();
}

function normalizeFavorite(value) {
  if (!value || typeof value !== "object") throw new TypeError("favorite must be an object");
  const organizationId = safeId(value.organizationId, "organizationId");
  const agentProjectId = safeId(value.agentProjectId, "agentProjectId");
  const kind = String(value.kind ?? "");
  const slug = String(value.slug ?? "");
  if (!KINDS.has(kind)) throw new TypeError("favorite kind is invalid");
  if (!SLUG.test(slug)) throw new TypeError("favorite slug is invalid");
  if (!Array.isArray(value.labels) || value.labels.length > 20) {
    throw new TypeError("favorite labels are invalid");
  }
  const labels = value.labels.map((label) => String(label).trim());
  if (labels.some((label) => label.length < 1 || label.length > 100)) {
    throw new TypeError("favorite labels are invalid");
  }
  return Object.freeze({
    organizationId,
    agentProjectId,
    kind,
    slug,
    labels: Object.freeze(labels),
  });
}

export function createProjectFavoriteStore(options = {}) {
  const directory = path.resolve(
    options.directory ?? path.join(getProjectRoot(), "data", "project-favorites"),
  );

  function organizationDirectory(organizationId) {
    return path.join(directory, safeId(organizationId, "organizationId"));
  }

  function favoritePath(organizationId, agentProjectId) {
    return path.join(
      organizationDirectory(organizationId),
      `${safeId(agentProjectId, "agentProjectId")}.json`,
    );
  }

  return Object.freeze({
    list(organizationId) {
      const ownerDirectory = organizationDirectory(organizationId);
      if (!fs.existsSync(ownerDirectory)) return [];
      return fs.readdirSync(ownerDirectory)
        .filter((name) => UUID_V4.test(name.slice(0, -5)) && name.endsWith(".json"))
        .map((name) => {
          try {
            const favorite = normalizeFavorite(
              JSON.parse(fs.readFileSync(path.join(ownerDirectory, name), "utf8")),
            );
            return favorite.organizationId === safeId(organizationId, "organizationId")
              ? favorite
              : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },

    read(organizationId, agentProjectId) {
      const file = favoritePath(organizationId, agentProjectId);
      if (!fs.existsSync(file)) return null;
      try {
        const favorite = normalizeFavorite(JSON.parse(fs.readFileSync(file, "utf8")));
        return favorite.organizationId === safeId(organizationId, "organizationId") &&
          favorite.agentProjectId === safeId(agentProjectId, "agentProjectId")
          ? favorite
          : null;
      } catch {
        return null;
      }
    },

    write(value) {
      const favorite = normalizeFavorite(value);
      const ownerDirectory = organizationDirectory(favorite.organizationId);
      fs.mkdirSync(ownerDirectory, { recursive: true });
      const target = favoritePath(favorite.organizationId, favorite.agentProjectId);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(favorite, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        fs.renameSync(temporary, target);
      } catch (error) {
        try {
          fs.unlinkSync(temporary);
        } catch {}
        throw error;
      }
      return favorite;
    },

    remove(organizationId, agentProjectId) {
      const file = favoritePath(organizationId, agentProjectId);
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    },
  });
}

