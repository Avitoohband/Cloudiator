'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { GameInfoEditor } from './GameInfoEditor';
import { FeedbackReview } from './FeedbackReview';
import { listFeedback } from './feedback-review';
import { editGameInfo, guideThumbnail, loadDraftGameInfo, loadPublishedGameInfo, type GameInfoEntry, type GameInfoPages, type GameInfoSnapshot, type GameInfoTab } from './game-info-client';
import type { EditorProbe } from './new-feedback';
import { futureUpdates, wikiTopics } from './public-content';
import { Pager } from '../paging/Pager';
import { PagingScope, PanelFooter } from '../paging/PanelFooter';
import { usePagedList } from '../paging/usePagedList';
import styles from './game-info.module.css';

const tabs = [{ id: 'wiki', label: 'Wiki' }, { id: 'future', label: 'Future Updates' }] as const;
/** Patch 1.9: the owner's third tab, shown only when the editor read succeeds (a Game Info editor), with its count of New feedback. */
const FEEDBACK_TAB = { id: 'feedback', label: 'Feedback' } as const;
type ShownTab = typeof tabs[number] | typeof FEEDBACK_TAB;
/** How long "Loading Game Info…" waits for the published pages before the built-in text shows. */
const LOADING_MS = 4_000;
const stopCopy = (event: ClipboardEvent) => event.preventDefault();
const wikiFallback: GameInfoEntry[] = wikiTopics.map(({ text, ...entry }) => ({ ...entry, body: text }));

/** One Wiki guide: a card with YouTube's picture, the play mark, the length and the topic. A failed picture leaves the dark frame. */
function GuideCard({ title, video, length }: { title: string; video: string; length?: string }) {
  const [failed, setFailed] = useState(false);
  const picture = guideThumbnail(video);
  return <a className={styles.gcard} href={video} target="_blank" rel="noopener noreferrer"
    aria-label={`Watch the guide${length ? `, ${length},` : ''} on YouTube (opens in a new tab)`}>
    <span className={styles.thumb}>
      {picture && !failed && <img src={picture} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
      <span className={styles.play} aria-hidden="true">▶</span>
    </span>
    <span className={styles.gtext}>
      <b>Watch the guide{length ? ` · ${length}` : ''}</b>
      <span>{title}</span>
      <span className={styles.yt}>YouTube ↗</span>
    </span>
  </a>;
}

const futureIds = ['parties', 'friends', 'items', 'seasonal'];
const futureFallback = futureUpdates.map(({ title, text }, index) => ({ id: futureIds[index], title, body: text, patch: undefined }));

export function GameInfoPanel({ id, onClose, update, fixture, editorAccount, onDirty, allowDiscard, onEditorProbe }: {
  id: string;
  onClose(): void;
  update?: { number: string; reload(): void };
  fixture: boolean;
  editorAccount: string | null;
  onDirty(dirty: boolean): void;
  allowDiscard(): boolean;
  /** What the editor probe found (final fix wave): the corner chip then counts New feedback for an editor (`useNewFeedback`). */
  onEditorProbe?(result: EditorProbe): void;
}) {
  const [active, setActive] = useState(0);
  const [topic, setTopic] = useState('combat');
  const panel = useRef<HTMLElement>(null);
  const topics = useRef<HTMLDivElement>(null);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [pages, setPages] = useState<GameInfoPages>({});
  // Patch 1.9 Task 31: the built-in Wiki and Future Updates are the fallback when nothing was published, not what shows first. Until the
  // published (or draft) pages have been read, or the read has failed, a steady "Loading Game Info…" shows, so the built-in text never
  // flashes before the real text replaces it. The plain fixture preview has nothing to read and shows the built-in text at once.
  const [settled, setSettled] = useState(() => fixture && !(typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('info') === 'draft'));
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState<GameInfoSnapshot | null>(null);
  const [loadingEditor, setLoadingEditor] = useState(false);
  const [editorFailed, setEditorFailed] = useState(false);
  const [feedbackNew, setFeedbackNew] = useState(0);
  const shownTabs: readonly ShownTab[] = canEdit ? [...tabs, FEEDBACK_TAB] : tabs;
  const pending = useRef(0);
  const probeReport = useRef(onEditorProbe);
  probeReport.current = onEditorProbe;
  const wiki = pages.wiki?.document.entries ?? wikiFallback;
  const future = pages.future?.document.entries ?? futureFallback;
  const article = wiki.find(item => item.id === topic) ?? wiki[0];
  const currentTab = shownTabs[active] ?? tabs[0];
  // Wiki topics 5 a page and Future Updates entries 8 a page (the article and each entry keep their scroll); a tab change goes back to page 1.
  const wikiPaged = usePagedList(wiki, { list: 'wikiTopics', resetKey: active });
  const futurePaged = usePagedList(future, { list: 'future', resetKey: active });
  // The listbox's active option is always one on the page shown (fix round 1, I4): the one last moved to, else the chosen topic, else (after a page
  // turn to a page with neither) the first topic of the page. It is not selected until a key or a click chooses it; the arrow keys step from it.
  const [activeId, setActiveId] = useState<string | null>(null);
  const onWikiPage = (id: string | null | undefined) => id != null && wikiPaged.rows.some(row => row.id === id);
  const activeTopicId = onWikiPage(activeId) ? activeId : onWikiPage(article?.id) ? article!.id : wikiPaged.rows[0]?.id;
  // A page turn keeps the focus on the listbox (never on an option: the listbox is a composite whose active option is `aria-activedescendant`, and a
  // focused option would unmount on the next jump), and brings the active option into view. The list's own `listRef` is not given to the paging
  // hook, so it does not move the focus to the first row.
  const lastWikiPage = useRef(wikiPaged.page);
  useEffect(() => {
    if (lastWikiPage.current === wikiPaged.page) return;
    lastWikiPage.current = wikiPaged.page;
    const here = document.activeElement;
    if (here && (topics.current?.contains(here) || here.closest('[data-pager]'))) topics.current?.focus({ preventScroll: true });
    if (activeTopicId) document.getElementById(optionId(activeTopicId))?.scrollIntoView?.({ block: 'nearest' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wikiPaged.page]);
  /** The tab the editor works on (Wiki or Future Updates; the Feedback tab has no editor). */
  const editTab = currentTab.id === 'feedback' ? null : currentTab.id;
  const tabId = (key: string) => `${id}-${key}-tab`;
  const panelId = (key: string) => `${id}-${key}-panel`;
  const optionId = (key: string) => `${id}-topic-${key}`;

  useEffect(() => {
    // The chosen topic's page shows (an arrow key, or the tab coming back), then only the list (not the panel) scrolls so the row is inside.
    const at = article ? wiki.findIndex(item => item.id === article.id) : -1;
    // Only when the choice, the tab or the topics change: a turn of the player's own (Back, Next, a circle) is left alone.
    const first = (wikiPaged.page - 1) * wikiPaged.size;
    if (active === 0 && editing === null && at >= 0 && (at < first || at >= first + wikiPaged.size)) wikiPaged.goToIndex(at);
    const list = topics.current;
    const option = article && list?.querySelector<HTMLElement>(`[id="${optionId(article.id)}"]`);
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id, active, pages.wiki, editing]);

  function moveTopic(event: KeyboardEvent<HTMLDivElement>) {
    // Alt, Ctrl or Meta with a key is the browser's or the system's (Alt+Up, Ctrl+End...), never a move in the list (Task 21).
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = Math.max(0, wiki.findIndex(item => item.id === activeTopicId));
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, wiki.length - 1) : event.key === 'ArrowUp' ? Math.max(at - 1, 0)
      : event.key === 'Home' ? 0 : event.key === 'End' ? wiki.length - 1 : null;
    if (next === null || !wiki[next]) return;
    event.preventDefault();
    setTopic(wiki[next].id);
    setActiveId(wiki[next].id);
  }

  // A read that stalls does not hold the player at the loading line: after 4 s the built-in text shows, and a published read that lands later replaces it.
  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(() => setSettled(true), LOADING_MS);
    return () => window.clearTimeout(timer);
  }, [settled]);

  useEffect(() => {
    let alive = true;
    if (fixture) {
      // `?mode=fixture&info=draft` previews the drafts in docs/game-info (fixture builds only).
      if (new URLSearchParams(window.location.search).get('info') === 'draft') void loadDraftGameInfo().then(next => {
        if (alive) { setPages(next); setSettled(true); }
      }, () => { if (alive) setSettled(true); });
      return () => { alive = false; };
    }
    void loadPublishedGameInfo().then(next => {
      if (alive) { setPages(previous => ({ ...next, ...previous })); setSettled(true); }
    }, () => { if (alive) setSettled(true); });
    if (editorAccount) void editGameInfo({ tab: 'wiki', action: 'read' }).then(result => {
      if (!alive) return;
      setCanEdit(result.ok);
      probeReport.current?.(result.ok ? 'editor' : result.code === 'forbidden' ? 'forbidden' : 'unknown');
      // The Feedback tab's count of New items, before the tab is opened (it reads its own list then).
      if (result.ok) void listFeedback('new').then(list => { if (alive && list.ok) setFeedbackNew(list.newCount); });
    });
    return () => { alive = false; pending.current++; };
  }, [fixture, editorAccount]);

  useLayoutEffect(() => {
    const element = panel.current;
    const chip = element?.parentElement;
    if (!element || !chip) return;
    const viewport = window.visualViewport;
    const fit = () => {
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const available = Math.max(0, Math.floor(bottom - element.getBoundingClientRect().top - 12));
      element.style.setProperty('--game-info-height', `${available}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(chip);
    window.addEventListener('resize', fit);
    viewport?.addEventListener('resize', fit);
    tabButtons.current[0]?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      viewport?.removeEventListener('resize', fit);
    };
  }, []);

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = shownTabs.length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
      : event.key === 'ArrowRight' ? (index + 1) % count
      : event.key === 'ArrowLeft' ? (index + count - 1) % count : null;
    if (next === null) return;
    event.preventDefault();
    changeTab(next);
    tabButtons.current[next]?.focus();
  }

  function changeTab(index: number) {
    pending.current++;
    setActive(index);
    setLoadingEditor(false);
    setEditorFailed(false);
  }

  async function beginEdit(tab: GameInfoTab) {
    const request = ++pending.current;
    setLoadingEditor(true);
    setEditorFailed(false);
    const result = await editGameInfo({ tab, action: 'read' });
    if (request !== pending.current) return;
    setLoadingEditor(false);
    if (result.ok) setEditing(result);
    else setEditorFailed(true);
  }

  function closeEditor() {
    setEditing(null);
    requestAnimationFrame(() => tabButtons.current[active]?.focus());
  }

  return <section ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`} className={styles.panel}>
    <header className={styles.head}>
      <h2 id={`${id}-title`}>Game Info</h2>
      <button type="button" className={styles.close} aria-label="Close Game Info" onClick={onClose}>×</button>
    </header>
    {update && <div className={styles.update} role="status">
      <p>Patch {update.number} is out</p>
      <button type="button" onClick={update.reload}>Reload</button>
    </div>}
    <div role="tablist" aria-label="Game information" className={styles.tabs}>
      {shownTabs.map((tab, index) => {
        const count = tab.id === 'feedback' && feedbackNew > 0 ? feedbackNew : 0;
        return <button key={tab.id} id={tabId(tab.id)} type="button" role="tab" aria-selected={active === index}
          aria-controls={panelId(tab.id)} tabIndex={active === index ? 0 : -1} ref={button => { tabButtons.current[index] = button; }}
          aria-label={count > 0 ? `${tab.label}, ${count} new` : undefined}
          disabled={editing !== null} onClick={() => changeTab(index)} onKeyDown={event => moveTab(event, index)}>
          {tab.label}{count > 0 && <span className={styles.count} aria-hidden="true">{count > 99 ? '99+' : count}</span>}
        </button>;
      })}
    </div>
    <PagingScope className={styles.paged} bodyClassName={styles.pagedBody}>
    <section id={panelId('wiki')} role="tabpanel" aria-labelledby={tabId('wiki')} className={styles.body} hidden={active !== 0 || editing !== null} tabIndex={0}>
      {!settled ? active === 0 && <p role="status" className={styles.loading}>Loading Game Info…</p> : active === 0 && editing === null && <>
        <div ref={topics} role="listbox" aria-label="Wiki topics" tabIndex={0} className={styles.topics}
          aria-activedescendant={activeTopicId ? optionId(activeTopicId) : undefined} onKeyDown={moveTopic}>
          <div role="presentation">
            {wikiPaged.rows.map(item => {
              const chosen = item.id === article?.id;
              return <div key={item.id} id={optionId(item.id)} role="option" aria-selected={chosen} aria-label={item.video ? `${item.title}, video guide` : undefined} className={styles.topic}
                data-page-row="" onClick={() => { setTopic(item.id); setActiveId(item.id); }}>
                <span aria-hidden="true" className={styles.mark}>{chosen ? '✓' : ''}</span>{item.title}
                {item.video && <span aria-hidden="true" className={styles.pm} title="Has a video guide">▶</span>}
              </div>;
            })}
          </div>
        </div>
        <Pager list={wikiPaged} show />
        {article && <article className={`${styles.entry} ${styles.readText}`} onCopy={stopCopy} aria-labelledby={`${id}-article`}>
          <h3 id={`${id}-article`}>{article.title}</h3>
          {article.video ? <GuideCard key={article.video} title={article.title} video={article.video} length={article.videoLength} />
            : <p className={styles.soon}>Video guide coming soon</p>}
          <p>{article.body}</p>
        </article>}
      </>}
    </section>
    <section id={panelId('future')} role="tabpanel" aria-labelledby={tabId('future')} className={styles.body} hidden={active !== 1 || editing !== null} tabIndex={0}>
      {!settled ? active === 1 && <p role="status" className={styles.loading}>Loading Game Info…</p> : active === 1 && editing === null && <div className={styles.readText} onCopy={stopCopy}>
        <p className={styles.intro}>Plans for upcoming patches. Patch numbers appear when confirmed.</p>
        <ul className={styles.roadmap} ref={futurePaged.listRef as RefObject<HTMLUListElement | null>}>{futurePaged.rows.map(item => <li className={styles.entry} key={item.id} data-page-row="" tabIndex={-1}>
          <h3>{item.title}</h3>
          {item.patch && <p>Patch {item.patch}</p>}
          <p>{item.body}</p>
        </li>)}</ul>
        <PanelFooter><Pager list={futurePaged} show /></PanelFooter>
      </div>}
    </section>
    {canEdit && <section id={panelId('feedback')} role="tabpanel" aria-labelledby={tabId('feedback')} className={styles.body} hidden={currentTab.id !== 'feedback' || editing !== null}>
      {currentTab.id === 'feedback' && <FeedbackReview onCount={setFeedbackNew} />}
    </section>}
    </PagingScope>
    {editing && editTab ? <GameInfoEditor tab={editTab} initial={editing} selectedId={article?.id ?? ''} publishedVersion={pages[editTab]?.version}
      onDirty={onDirty} onClose={() => { if (allowDiscard()) closeEditor(); }}
      onPublished={snapshot => { setPages(previous => ({ ...previous, [editTab]: snapshot })); closeEditor(); }} />
      : canEdit && editTab && <footer className={styles.editBar}>
        {editorFailed && <p role="alert">The draft could not be opened.</p>}
        <button type="button" disabled={loadingEditor} onClick={() => void beginEdit(editTab)}>Edit {currentTab.label}</button>
      </footer>}
  </section>;
}
