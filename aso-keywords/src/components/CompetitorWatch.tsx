import { useEffect, useState } from 'react';
import { watchApi, type WatchDigest, type WatchList } from '../competitorWatchApi';

interface Props {
  appId: string;
  competitor: { bundleId: string; name: string };
  storefront: string;
  watch: WatchList | null;
  onChanged: () => void;
}

const fmtNum = (value: number | null) => (value == null ? '—' : String(Math.round(value)));
const fmtPop = (value: number | null) => (value == null ? '—' : value <= 5 ? '≤5' : String(value));
const fmtWhen = (value: number | null) => (value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export default function CompetitorWatch({ appId, competitor, storefront, watch, onChanged }: Props) {
  const item = watch?.competitors.find((row) => row.bundleId === competitor.bundleId) ?? null;
  const competitorId = item?.competitorId ?? null;
  const lastReview = item?.digests[storefront] ?? null;
  const running = Boolean(item && watch?.running && watch.running.competitorId === item.competitorId);
  const [payload, setPayload] = useState<{ generatedAt: number | null; digest: WatchDigest | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!competitorId) return;
    let cancelled = false;
    watchApi.digest(appId, competitorId, storefront)
      .then((data) => { if (!cancelled) setPayload(data); })
      .catch(() => { if (!cancelled) setPayload(null); });
    return () => { cancelled = true; };
  }, [appId, competitorId, storefront, lastReview]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      onChanged();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!item) {
    return (
      <section className="competitor-panel">
        <h2>Недельный разбор</h2>
        <p className="competitor-muted">
          Раз в неделю, после ночного обновления рангов, трекер сверит название и подзаголовок конкурента, проверит фразы из его метаданных
          и соберёт слова, по которым он в выдаче, а мы нет. Разбор идёт по всем витринам приложения, не чаще 25 в ночь.
        </p>
        <button type="button" className="ds-btn" disabled={busy} onClick={() => act(() => watchApi.add(appId, competitor.bundleId))}>Следить еженедельно</button>
        {message ? <p role="alert">{message}</p> : null}
      </section>
    );
  }

  const digest = payload?.digest ?? null;
  return (
    <section className="competitor-panel">
      <header className="competitor-section-heading">
        <h2>Недельный разбор · {storefront.toUpperCase()}</h2>
        <span className="competitor-muted">последний: {fmtWhen(lastReview)}</span>
      </header>
      <div>
        <button type="button" className="ds-btn" disabled={busy || running} onClick={() => act(() => watchApi.run(appId, item.competitorId, storefront))}>
          {running ? 'Идёт разбор…' : 'Разобрать сейчас'}
        </button>{' '}
        <button type="button" className="ds-btn ds-btn-sm" disabled={busy} onClick={() => act(() => watchApi.remove(appId, item.competitorId))}>Убрать из наблюдения</button>
      </div>
      {message ? <p role="alert">{message}</p> : null}
      {watch?.lastError ? <p className="competitor-muted" role="status">Последняя ошибка разбора: {watch.lastError}</p> : null}
      {running ? <p className="competitor-muted" role="status">Сейчас разбирается витрина {watch?.running?.storefront.toUpperCase()}. Займёт несколько минут.</p> : null}

      {!digest ? (
        <p className="competitor-muted">Для этой витрины разбора ещё нет. Первый пройдёт в ближайшие ночи после обновления рангов или запусти вручную.</p>
      ) : (
        <>
          <p className="competitor-muted">
            {digest.competitor.name}{digest.competitor.subtitle ? ` — ${digest.competitor.subtitle}` : ''} · оценок {fmtNum(digest.competitor.ratings)}.
            Выдач проверено {digest.coverage.checked}, в {digest.coverage.found} из них конкурент найден; в этот раз проверено новых фраз: {digest.checkedNow}.
          </p>
          {digest.changes.length ? (
            <div role="status">
              <strong>Изменилось с прошлого разбора</strong>
              <ul>{digest.changes.map((change) => <li key={change.field}>{change.field === 'name' ? 'Название' : 'Подзаголовок'}: «{change.from ?? '—'}» → «{change.to ?? '—'}»</li>)}</ul>
            </div>
          ) : <p className="competitor-muted">Название и подзаголовок не менялись.</p>}
          <h3>Слова, по которым он в выдаче, а мы нет ({digest.counts.theirs})</h3>
          {digest.gaps.length ? (
            <div className="ds-table-wrap spy-table-wrap">
              <table className="ds-table spy-table">
                <thead><tr><th>Ключ</th><th>У них</th><th>Популярность</th><th>Сложность</th><th>Шанс</th></tr></thead>
                <tbody>
                  {digest.gaps.map((gap) => (
                    <tr key={gap.keyword}>
                      <td className="spy-kw">
                        <span className="spy-kw-text">{gap.keyword}</span>
                        <span className="spy-markers">
                          {gap.isNew ? <span className="ds-badge ds-badge-good">новое</span> : null}
                          {gap.inTheirTitle ? <span className="ds-badge">название</span> : null}
                          {gap.inTheirSubtitle ? <span className="ds-badge">подзаголовок</span> : null}
                        </span>
                      </td>
                      <td className="spy-num">{gap.theirRank == null ? '—' : `#${gap.theirRank}`}</td>
                      <td className="spy-num">{fmtPop(gap.popularity)}</td>
                      <td className="spy-num">{fmtNum(gap.difficulty)}</td>
                      <td className="spy-num">{fmtNum(gap.chance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="competitor-muted">Пока нет фраз, по которым конкурент в выдаче, а мы нет. Данных станет больше с каждой неделей проверок.</p>}
        </>
      )}
    </section>
  );
}
