'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { editGameInfo, guideLength, youtubeLink, type GameInfoEntry, type GameInfoSnapshot, type GameInfoTab } from './game-info-client';
import styles from './game-info.module.css';

const errors = {
  conflict: 'This draft changed elsewhere. Your text is still here. Reload the saved draft when you are ready.',
  forbidden: 'Your account can no longer edit this content.',
  invalid: 'Check the title, text, patch number, guide link and length before saving.',
  unavailable: 'The editor is unavailable. Your text is still here.',
};

export function GameInfoEditor({ tab, initial, selectedId, publishedVersion, onClose, onPublished, onDirty }: {
  tab: GameInfoTab;
  initial: GameInfoSnapshot;
  selectedId: string;
  publishedVersion: number | undefined;
  onClose(): void;
  onPublished(snapshot: GameInfoSnapshot): void;
  onDirty(dirty: boolean): void;
}) {
  const id = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial.document);
  const [selected, setSelected] = useState(selectedId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<keyof typeof errors | null>(null);
  const entry = draft.entries.find(item => item.id === selected) ?? draft.entries[0];
  const linkError = (item: GameInfoEntry | undefined) => !!item?.video && !youtubeLink(item.video);
  const lengthError = (item: GameInfoEntry | undefined) => !!item?.videoLength && !guideLength(item.videoLength);
  const badEntry = draft.entries.find(item => linkError(item) || lengthError(item));
  const dirty = JSON.stringify(saved.document) !== JSON.stringify(draft);
  useLayoutEffect(() => { (titleInput.current ?? addButton.current)?.focus(); }, []);
  useLayoutEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useLayoutEffect(() => () => onDirty(false), [onDirty]);

  function change(fields: Partial<GameInfoEntry>) {
    setDraft(previous => ({ ...previous, entries: previous.entries.map(item => item.id === entry?.id ? { ...item, ...fields } : item) }));
    setNotice(null);
  }

  async function submit(action: 'save' | 'publish' | 'read') {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    const document = { ...draft, entries: draft.entries.map(({ patch, video, videoLength, ...item }) => ({ ...item, ...(patch?.trim() ? { patch: patch.trim() } : {}),
      ...(tab === 'wiki' && video?.trim() ? { video: video.trim(), ...(videoLength?.trim() ? { videoLength: videoLength.trim() } : {}) } : {}) })) };
    const result = await editGameInfo(action === 'read' ? { tab, action } : action === 'publish'
      ? { tab, action, expectedVersion: saved.version } : { tab, action, expectedVersion: saved.version, document });
    setBusy(false);
    if (!result.ok) { setError(result.code); return; }
    const next = { version: result.version, document: result.document };
    setSaved(next);
    setDraft(next.document);
    if (action === 'publish') onPublished(next);
    else setNotice(action === 'save' ? 'Draft saved.' : 'Saved draft loaded.');
  }

  return <form className={`${styles.body} ${styles.editor}`} onSubmit={event => { event.preventDefault(); void submit('save'); }}>
    <h3>Edit {tab === 'wiki' ? 'Wiki' : 'Future Updates'}</h3>
    <fieldset disabled={busy}>
      <label htmlFor={`${id}-entry`}>Entry</label>
      <select id={`${id}-entry`} value={entry?.id ?? ''} onChange={event => setSelected(event.target.value)}>
        {!entry && <option value="">Add an entry</option>}
        {draft.entries.map(item => <option key={item.id} value={item.id}>{item.title || 'Untitled entry'}</option>)}
      </select>
      <div className={styles.actions}>
        <button ref={addButton} type="button" disabled={draft.entries.length >= 40} onClick={() => {
          const newEntry = { id: `entry-${crypto.randomUUID()}`, title: '', body: '' };
          setDraft(previous => ({ ...previous, entries: [...previous.entries, newEntry] }));
          setSelected(newEntry.id);
        }}>Add entry</button>
        {entry && <button type="button" onClick={() => setDraft(previous => ({ ...previous, entries: previous.entries.filter(item => item.id !== entry.id) }))}>Remove entry</button>}
      </div>
      {entry && <>
        <label htmlFor={`${id}-title`}>Title</label>
        <input ref={titleInput} id={`${id}-title`} value={entry.title} maxLength={80} required onChange={event => change({ title: event.target.value })} />
        <label htmlFor={`${id}-body`}>Text</label>
        <textarea id={`${id}-body`} value={entry.body} maxLength={4000} rows={4} required onChange={event => change({ body: event.target.value })} />
        {tab === 'wiki' && <>
          <label htmlFor={`${id}-video`}>YouTube guide</label>
          <input id={`${id}-video`} type="url" value={entry.video ?? ''} placeholder="https://youtu.be/..." aria-invalid={linkError(entry)}
            aria-describedby={linkError(entry) ? `${id}-video-error` : undefined}
            onChange={event => change(event.target.value ? { video: event.target.value } : { video: undefined, videoLength: undefined })} />
          {linkError(entry) && <p id={`${id}-video-error`} className={styles.fieldError}>Enter a YouTube video URL.</p>}
          <label htmlFor={`${id}-length`}>Guide length</label>
          <input id={`${id}-length`} value={entry.videoLength ?? ''} placeholder="1:12" maxLength={5} disabled={!entry.video} aria-invalid={lengthError(entry)}
            aria-describedby={lengthError(entry) ? `${id}-length-error` : undefined}
            onChange={event => change({ videoLength: event.target.value || undefined })} />
          {lengthError(entry) && <p id={`${id}-length-error`} className={styles.fieldError}>Enter the length as minutes:seconds, like 1:12.</p>}
        </>}
        {tab === 'future' && <>
          <label htmlFor={`${id}-patch`}>Patch number (optional)</label>
          <input id={`${id}-patch`} value={entry.patch ?? ''} placeholder="1.9" maxLength={11} onChange={event => change({ patch: event.target.value })} />
        </>}
      </>}
      <div className={styles.actions}>
        <button type="button" onClick={onClose}>Close editor</button>
        <button type="submit" disabled={!dirty || !!badEntry}>Save draft</button>
        <button type="button" disabled={dirty || saved.version === publishedVersion || error === 'conflict'} onClick={() => void submit('publish')}>Publish</button>
      </div>
    </fieldset>
    {badEntry && badEntry.id !== entry?.id && <p>Fix the guide link or length of {badEntry.title || 'an untitled entry'} before saving.</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{errors[error]}</p>}
    {error === 'conflict' && <button type="button" disabled={busy} onClick={() => void submit('read')}>Discard local edits and reload</button>}
  </form>;
}
