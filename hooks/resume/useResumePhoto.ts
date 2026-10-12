'use client';

// hooks/resume/useResumePhoto.ts — the resume photo stays on this device
// (WP-65). It is kept in this browser only, sent with a download request when
// the layout says "place my photo", and never stored on the server (GoApply
// CN-0 keeps no photo; CN_TW_LAUNCH_PLAN.md). Every storage access is guarded:
// private windows and blocked storage simply mean "no photo kept".

import { useCallback, useEffect, useState } from 'react';

const KEY_PREFIX = 'ra_resume_photo:';
/** The builder keeps one photo per signed-in user until the resume exists. */
const DRAFT_PHOTO_PREFIX = 'draft';
/** The builder's photo key for one user (`ra_resume_photo:draft:<userId>`). */
export function draftPhotoId(userId: string): string {
  return `${DRAFT_PHOTO_PREFIX}:${userId}`;
}
/** Builder drafts in this browser (lib-free copy of draft.ts's prefix). */
const BUILDER_DRAFT_PREFIX = 'ra_resume_builder_draft';
/** Longest side after downscaling, and the JPEG quality. */
export const PHOTO_MAX_SIDE = 480;
const PHOTO_QUALITY = 0.85;
/** The server accepts up to 512 KB; data URLs are about 4/3 of that. */
export const PHOTO_MAX_DATA_URL = 680_000;

export function readStoredPhoto(id: string): string | null {
  try {
    const v = window.localStorage.getItem(KEY_PREFIX + id);
    return v && v.startsWith('data:image/') ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredPhoto(id: string, dataUrl: string | null): boolean {
  try {
    if (dataUrl) window.localStorage.setItem(KEY_PREFIX + id, dataUrl);
    else window.localStorage.removeItem(KEY_PREFIX + id);
    return true;
  } catch {
    return false;
  }
}

/**
 * After a create: move the builder's photo onto the new resume when the user
 * kept it, and always remove the draft copy (adopted or not).
 */
export function settleDraftPhoto(input: { userId: string | null | undefined; resumeId: string; photo: string | null; adopt: boolean }): void {
  if (input.adopt && input.photo) writeStoredPhoto(input.resumeId, input.photo);
  if (input.userId) writeStoredPhoto(draftPhotoId(input.userId), null);
}

/** Remove every builder draft photo in this browser except `keepUserId`'s (null = remove all). */
export function purgeDraftPhotos(keepUserId: string | null): void {
  try {
    const keep = keepUserId ? KEY_PREFIX + draftPhotoId(keepUserId) : null;
    const base = KEY_PREFIX + DRAFT_PHOTO_PREFIX;
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && (k === base || k.startsWith(`${base}:`)) && k !== keep) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    // storage unavailable: nothing kept
  }
}

/**
 * Sign-out / session-expired cleanup: removes every unsent builder draft and
 * builder draft photo in this browser. Photos already on a resume are keyed by
 * that resume's id (only its owner can open it); pass `resumePhotos: true` to
 * remove those too.
 */
export function clearResumeBuilderDeviceData(options: { resumePhotos?: boolean } = {}): void {
  purgeDraftPhotos(null);
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (!k) continue;
      if (k === BUILDER_DRAFT_PREFIX || k.startsWith(`${BUILDER_DRAFT_PREFIX}:`)) doomed.push(k);
      else if (options.resumePhotos && k.startsWith(KEY_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    // storage unavailable: nothing kept
  }
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * A JPEG/PNG file → a downscaled JPEG data URL (longest side 480 px). Where a
 * canvas is unavailable the original is kept if it is small enough.
 */
export async function photoToDataUrl(file: File): Promise<string> {
  if (!/^image\/(jpeg|png)$/.test(file.type)) throw new Error('unsupported_photo');
  const original = await readAsDataUrl(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode_failed'));
      el.src = original;
    });
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no_canvas');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
    if (out.startsWith('data:image/jpeg') && out.length <= PHOTO_MAX_DATA_URL) return out;
  } catch {
    // fall through to the original
  }
  if (original.length > PHOTO_MAX_DATA_URL) throw new Error('photo_too_large');
  return original;
}

/**
 * The device photo for one resume (or a user's builder draft). With a null id
 * the photo lives for this visit only (nothing is written to storage).
 */
export function useResumePhoto(id: string | null) {
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    setPhoto(id ? readStoredPhoto(id) : null);
  }, [id]);
  const save = useCallback(
    async (file: File) => {
      const url = await photoToDataUrl(file);
      if (id) writeStoredPhoto(id, url);
      setPhoto(url);
      return url;
    },
    [id],
  );
  const remove = useCallback(() => {
    if (id) writeStoredPhoto(id, null);
    setPhoto(null);
  }, [id]);
  return { photo, save, remove };
}
