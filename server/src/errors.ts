// Domain error → HTTP response, the ONE place that mapping lives
// (docs/style-guide.md: "API handlers translate errors to HTTP status codes in
// one place, never inline"). Handlers and the service layer throw typed errors
// and know nothing about status codes; everything a client sees as an error
// status was decided here.
import {
  AssetNotAnImage,
  AssetTooLarge,
  AssetTypeNotAllowed,
  AssetUnreadable,
  BoardAssetQuotaExceeded,
} from "./assets.ts";
import {
  BoardEnded,
  BoardNotFound,
  ContentTooLarge,
  VersionConflict,
  VersionNotFound,
} from "./boards.ts";
import { ImportRejected } from "./bundle-import.ts";
import {
  CommentBodyRequired,
  CommentNotFound,
  InvalidAnchor,
} from "./comments.ts";
import { HttpError, jsonError } from "./http.ts";
import { InvalidAssetEmbed } from "./render.ts";
import { InvalidWebhookUrl, SubscriptionNotFound } from "./webhooks.ts";

export function errorResponse(
  err: unknown,
  headers: Record<string, string> = {},
): Response {
  if (err instanceof HttpError) {
    return jsonError(err.status, err.code, err.message, headers);
  }
  if (err instanceof VersionConflict) {
    // open-artifacts 409 pattern: agents read current_version and retry
    return jsonError(409, "version_conflict", err.message, headers, {
      current_version: err.current,
    });
  }
  if (err instanceof BoardNotFound) {
    return jsonError(404, "board_not_found", err.message, headers);
  }
  if (err instanceof CommentNotFound) {
    return jsonError(404, "comment_not_found", err.message, headers);
  }
  // reuses the existing invalid_request code — no new API error code (the
  // message carries the specifics)
  if (err instanceof CommentBodyRequired) {
    return jsonError(400, "invalid_request", err.message, headers);
  }
  if (err instanceof InvalidAnchor) {
    return jsonError(400, "invalid_anchor", err.message, headers);
  }
  if (err instanceof VersionNotFound) {
    return jsonError(404, "version_not_found", err.message, headers);
  }
  if (err instanceof BoardEnded) {
    return jsonError(409, "board_ended", err.message, headers);
  }
  if (err instanceof ContentTooLarge) {
    return jsonError(413, "payload_too_large", err.message, headers);
  }
  if (err instanceof AssetTooLarge) {
    return jsonError(413, "asset_too_large", err.message, headers);
  }
  if (err instanceof BoardAssetQuotaExceeded) {
    return jsonError(413, "board_asset_quota_exceeded", err.message, headers);
  }
  if (err instanceof AssetTypeNotAllowed) {
    return jsonError(400, "asset_type_not_allowed", err.message, headers);
  }
  if (err instanceof AssetNotAnImage) {
    return jsonError(400, "asset_not_an_image", err.message, headers);
  }
  if (err instanceof AssetUnreadable) {
    return jsonError(400, "asset_path_unreadable", err.message, headers);
  }
  if (err instanceof InvalidAssetEmbed) {
    // publish-time validation of markdown asset embeds — the agent's own src
    // echoed back so the fix is actionable (dogfooded: "asset:undefined")
    return jsonError(400, "invalid_asset_embed", err.message, headers);
  }
  if (err instanceof InvalidWebhookUrl) {
    return jsonError(400, "invalid_webhook_url", err.message, headers);
  }
  if (err instanceof SubscriptionNotFound) {
    return jsonError(404, "subscription_not_found", err.message, headers);
  }
  if (err instanceof ImportRejected) {
    // 422 over 400: the request was well-formed HTTP; the bundle's CONTENT
    // failed validation (quarantine, manifest schema, zip-slip) — the
    // message names the failing item and nothing was written
    return jsonError(422, "import_rejected", err.message, headers);
  }
  console.error("boardd: unhandled error", err);
  return jsonError(500, "internal_error", "internal error", headers);
}
