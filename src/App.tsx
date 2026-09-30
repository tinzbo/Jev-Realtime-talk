import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUp, AudioLines, Check, ChevronRight, Film, Keyboard, Mic, MicOff, Play, RotateCcw, Search, Settings2, Volume2, VolumeX, X } from 'lucide-react';
import type { Catalog, Clip, Decision, ServiceStatus, Turn } from './types';
import { TurnGate, readyVideo, decodedFrame, watchPlayback } from './playback';
import { VoiceSession, serverTranscriber, type VoiceState, type Transcription } from './voice';
import { captureMicrophone, captureFixture, canCaptureAudio, type CaptureFactory } from './capture';

const prompts = ['你能做什么？', '怎么批量制作数字人视频？', '怎么接入我的网站？'];
const saveJson = (filename: string, data: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export default function App() {
  const [catalog, setCatalog] = useState<Catalog>({ clips: [], assets: [] });
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [history, setHistory] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [lastRecognition, setLastRecognition] = useState<Transcription | null>(null);
  const [fixtureFile, setFixtureFile] = useState<File | null>(null);
  const [fixtureChoice, setFixtureChoice] = useState('');
  const fixtureMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has('voice-test');
  const [voiceState, setVoiceState] = useState<VoiceState>('off');
  const [voiceSupported] = useState(canCaptureAudio);
  const [textOpen, setTextOpen] = useState(!voiceSupported);
  const [current, setCurrent] = useState<Clip | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [mode, setMode] = useState<'preview' | 'live'>('live');
  const [panel, setPanel] = useState<'library' | 'settings' | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const idleVideo = useRef<HTMLVideoElement>(null);
  const video0 = useRef<HTMLVideoElement>(null), video1 = useRef<HTMLVideoElement>(null);
  const activeRef = useRef<number | null>(null), slotTurns = useRef([0, 0]);
  const historyRef = useRef<Turn[]>([]), played = useRef<string[]>([]);
  const gate = useRef(new TurnGate());
  const routing = useRef<AbortController | null>(null), media = useRef<AbortController | null>(null);
  const speech = useRef<VoiceSession | null>(null);
  const transcribe = useRef(serverTranscriber());
  const submitRef = useRef<(text: string) => Promise<void>>(async () => {});
  const dialog = useRef<HTMLDialogElement>(null), messages = useRef<HTMLDivElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true), configured = useRef(false), busyRef = useRef(false);
  const mutedRef = useRef(muted); mutedRef.current = muted;

  const refresh = useCallback(async () => {
    try {
      const responses = await Promise.all([fetch('/api/catalog'), fetch('/api/status')]);
      if (responses.some(response => !response.ok)) throw new Error('暂时无法读取内容库，请稍后重试。');
      const [data, services] = await Promise.all(responses.map(response => response.json()));
      if (!mounted.current) return;
      setCatalog(data); setStatus(services);
      if (!configured.current) { configured.current = true; if (!services.jev) setMode('preview'); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '连接失败'); }
  }, []);
  const setReplyBusy = (value: boolean) => { busyRef.current = value; setBusy(value); };
  const cancelTurn = useCallback(() => {
    gate.current.cancel(); routing.current?.abort(); media.current?.abort();
    video0.current?.pause(); video1.current?.pause();
    // Keep the listening video running underneath, without a reset/static frame.
    activeRef.current = null; setActive(null); setReplyBusy(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    speech.current = makeVoice(captureMicrophone);
    void refresh(); const timer = setInterval(() => { void refresh(); }, 10000);
    const hide = () => { if (document.hidden) { speech.current?.stop(); cancelTurn(); } };
    document.addEventListener('visibilitychange', hide);
    return () => {
      mounted.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', hide);
      speech.current?.dispose(); speech.current = null;
      gate.current.cancel(); routing.current?.abort(); media.current?.abort();
    };
  }, [refresh, cancelTurn]);
  function makeVoice(capture: CaptureFactory) {
    return new VoiceSession({ capture, transcribe: transcribe.current,
      onState: state => { if (mounted.current) setVoiceState(state); },
      onUtterance: text => { void submitRef.current(text); },
      onRecognized: result => { if (mounted.current) setLastRecognition(result); },
      onError: message => { if (mounted.current) { setError(message); setTextOpen(true); } },
    });
  }
  useEffect(() => { messages.current?.scrollTo({ top: messages.current.scrollHeight, behavior: 'smooth' }); }, [history]);
  useEffect(() => { if (textOpen) textInput.current?.focus(); }, [textOpen]);
  useEffect(() => {
    if (!fixtureMode || !fixtureChoice) return;
    const controller = new AbortController(); setFixtureFile(null);
    void fetch(`/api/voice/fixture/${fixtureChoice}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('合成样例未准备，请运行 npm run check:interaction -- --fixtures-only。');
      const blob = await response.blob();
      if (!controller.signal.aborted) setFixtureFile(new File([blob], `${fixtureChoice}.wav`, { type: 'audio/wav' }));
    }).catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [fixtureMode, fixtureChoice]);
  useEffect(() => {
    for (const video of [video0.current, video1.current]) if (video) video.muted = muted || video.dataset.silent === 'true';
  }, [muted]);
  useEffect(() => {
    if (panel && !dialog.current?.open) dialog.current?.showModal();
    if (!panel && dialog.current?.open) dialog.current.close();
  }, [panel]);

  const append = (turn: Turn) => { historyRef.current = [...historyRef.current, turn].slice(-40); setHistory(historyRef.current); };
  const playClip = async (clip: Clip, turn: number): Promise<boolean> => {
    if (!gate.current.accept(turn)) return false;
    const asset = catalog.assets.find(item => item.clipId === clip.id && (mode === 'preview' || item.status === 'ready'));
    if (!asset) { setError('这段视频暂未就绪，可以先聊其他话题。'); return false; }
    media.current?.abort(); const controller = new AbortController(); media.current = controller;
    const next = activeRef.current === 0 ? 1 : 0;
    const video = next === 0 ? video0.current : video1.current;
    if (!video) return false;
    try {
      video.loop = clip.loop; video.dataset.silent = String(!clip.text); video.muted = mutedRef.current || !clip.text;
      await readyVideo(video, asset.url, controller.signal);
      if (!gate.current.accept(turn) || controller.signal.aborted) return false;
      await video.play(); await decodedFrame(video, controller.signal);
      if (!gate.current.accept(turn) || controller.signal.aborted) return false;
      (next === 0 ? video1.current : video0.current)?.pause();
      slotTurns.current[next] = turn; activeRef.current = next; setActive(next); setCurrent(clip);
      watchPlayback(video, controller.signal, () => {
        if (!gate.current.accept(turn) || controller.signal.aborted || activeRef.current !== next) return;
        cancelTurn(); speech.current?.resume(); setTextOpen(true);
        setError('视频播放停住了，请重试或检查浏览器的声音输出。也可以继续输入。');
      });
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && gate.current.accept(turn)) {
        setError(cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? '浏览器暂未允许播放声音，请再点击一次语音按钮或话题。' : '这段视频暂时没能播放，请重试。');
      }
      return false;
    }
  };
  const submit = async (text: string) => {
    const userText = text.trim().slice(0, 1500); if (!userText) return;
    const previous = current?.id, priorHistory = historyRef.current.slice(-10);
    cancelTurn(); const turn = gate.current.next();
    const controller = new AbortController(); routing.current = controller;
    speech.current?.hold(); setDraft(''); setError(''); setReplyBusy(true);
    append({ role: 'user', text: userText });
    try {
      const response = await fetch('/api/route', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ requestId: turn, text: userText, history: priorHistory, currentClipId: previous, recentlyPlayed: played.current.slice(-8), mode }),
      });
      const result = await response.json() as Decision & { error?: string };
      if (!response.ok) throw new Error(result.error || '暂时没能接上这句话，请再试一次。');
      if (!gate.current.accept(turn)) return;
      setDecision(result);
      const clip = catalog.clips.find(item => item.id === result.clipId);
      if (!clip) throw new Error(result.reason);
      played.current = [...played.current, clip.id].slice(-10);
      append({ role: 'assistant', text: clip.text, clipId: clip.id });
      const playing = await playClip(clip, turn);
      if (!playing && gate.current.accept(turn)) { setReplyBusy(false); speech.current?.resume(); }
    } catch (cause) {
      if (controller.signal.aborted || !gate.current.accept(turn)) return;
      setError(cause instanceof Error ? cause.message : '连接暂时中断，请重试。');
      setReplyBusy(false); speech.current?.resume();
    }
  };
  submitRef.current = submit;
  const ended = (slot: number) => {
    if (activeRef.current !== slot || !gate.current.accept(slotTurns.current[slot])) return;
    activeRef.current = null; setActive(null); setReplyBusy(false); speech.current?.resume();
  };
  const voiceAction = () => {
    if (!voiceSupported) { setTextOpen(true); return; }
    setError('');
    if (voiceState === 'off') { cancelTurn(); setMuted(false); speech.current?.dispose(); speech.current = makeVoice(captureMicrophone); void speech.current.start(); }
    else if (voiceState === 'responding' || voiceState === 'transcribing' || busyRef.current) { cancelTurn(); speech.current?.interrupt(); }
    else speech.current?.stop();
  };
  const interrupt = () => { cancelTurn(); if (voiceState !== 'off') speech.current?.interrupt(); };
  const openPanel = (next: 'library' | 'settings') => { speech.current?.stop(); cancelTurn(); setPanel(next); };
  const audition = (clip: Clip) => {
    setPanel(null); cancelTurn(); setError('');
    const turn = gate.current.next(); setReplyBusy(true);
    void playClip(clip, turn).then(playing => { if (!playing && gate.current.accept(turn)) setReplyBusy(false); });
  };
  const readyAssets = catalog.assets.filter(asset => asset.status === 'ready');
  const idle = readyAssets.find(asset => asset.clipId === 'listen');
  const visible = catalog.clips.filter(clip => `${clip.title}${clip.intent}${clip.text}`.toLowerCase().includes(query.toLowerCase()));
  const voiceLabel = !voiceSupported ? '当前页面无法使用麦克风' : voiceState === 'off' ? '开始语音聊天'
    : voiceState === 'responding' ? '打断并说话' : voiceState === 'transcribing' ? '重新说一句' : voiceState === 'starting' ? '开启麦克风 · 点击取消' : '正在倾听 · 点击暂停';
  const voiceHint = !voiceSupported ? '请在 localhost 或 HTTPS 页面使用麦克风，也可以直接打字。'
    : voiceState === 'off' ? '点一次，就能连续聊。声音在本机识别，不依赖浏览器语音服务。'
    : voiceState === 'responding' ? '小岚说完会继续听，也可以随时打断。'
    : voiceState === 'transcribing' ? '听到了，正在理解这句话。' : voiceState === 'starting' ? '首次使用，请允许浏览器访问麦克风。' : '直接说就好。不用重复点击，也不必急着开口。';

  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="/" aria-label="Xtasy 首页"><AudioLines size={25} />xtasy<span>.</span></a><span className="header-note">一个随时接得上话的数字人</span><nav aria-label="工作室"><button onClick={() => openPanel('library')}><Film size={17} /><span>内容库</span></button><button className="icon-button" aria-label="设置" onClick={() => openPanel('settings')}><Settings2 size={19} /></button></nav></header>
    <main className="experience">
      <section className="avatar-panel" aria-label="小岚的动态画面">
        <img className="avatar-image" src="/avatar-reference.png" alt="虚构数字人小岚，坐在温暖的工作室里" />
        {idle && <video ref={idleVideo} className="idle-video" src={idle.url} autoPlay muted loop playsInline preload="auto" aria-label="持续倾听画面" onError={() => setError('倾听视频暂未加载成功，请刷新页面重试。')} />}
        {[0, 1].map(slot => <video key={slot} ref={slot === 0 ? video0 : video1} className={`response-video ${active === slot ? 'is-visible' : ''}`} playsInline preload="auto" aria-hidden={active !== slot} aria-label={`小岚的回应 ${slot + 1}`} onEnded={() => ended(slot)} />)}
        <div className="avatar-shade" /><div className="avatar-top"><span className="avatar-name">小岚<span>虚拟数字人</span></span><button className="sound-button" aria-label={muted ? '开启声音' : '静音'} onClick={() => setMuted(value => !value)}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button></div>
        {current?.text && <p className="avatar-caption">{current.text}</p>}
        {!current && <div className="avatar-welcome"><span>很高兴见到你</span><p>有话想聊，<br />我就在这里。</p></div>}
      </section>
      <section className="conversation" aria-labelledby="conversation-title">
        <div className="conversation-heading"><div><span className="eyebrow">LET’S TALK</span><h1 id="conversation-title">和小岚聊聊</h1></div><button className="icon-button reset-button" aria-label="清空对话" onClick={() => { interrupt(); historyRef.current = []; setHistory([]); played.current = []; }}><RotateCcw size={17} /></button></div>
        <div className="messages" ref={messages} role="log" aria-label="对话记录" aria-live="polite">
          {history.length === 0 ? <div className="conversation-empty"><h2>像聊天一样，<br />直接说出你的想法。</h2><p>想做什么样的数字人？需要多少段视频？<br className="desktop-break" />你可以从一个具体的问题开始。</p><div className="suggestions"><span>比如聊聊</span>{prompts.map(text => <button key={text} onClick={() => { void submit(text); }}>{text}<ChevronRight size={16} /></button>)}</div></div>
            : history.map((turn, index) => <div key={index} className={`message ${turn.role}`}><span className="message-name">{turn.role === 'user' ? '你' : '小岚'}</span><p>{turn.text}</p></div>)}
        </div>
        <div className="interaction-dock">
          {error && <div className="error-banner" role="alert"><p>{error}</p><button aria-label="关闭提示" onClick={() => setError('')}><X size={16} /></button></div>}
          {fixtureMode && <div className="voice-fixture"><label>合成语音回归<select aria-label="内置合成语音" value={fixtureChoice} onChange={event => setFixtureChoice(event.target.value)}><option value="">选择一段话</option><option value="hello">你好，小岚</option><option value="batch">怎么批量制作数字人视频</option><option value="website">怎么把你接入我的网站</option><option value="stop">停一下</option><option value="weather">明天北京会下雨吗</option><option value="thanks">好的，谢谢你</option></select></label><input type="file" accept="audio/*" aria-label="选择测试语音" onChange={event => { setFixtureChoice(''); setFixtureFile(event.target.files?.[0] || null); }} /><button disabled={!fixtureFile} onClick={() => { cancelTurn(); setError(''); setLastRecognition(null); speech.current?.dispose(); speech.current = makeVoice(captureFixture(fixtureFile!)); void speech.current.start(); }}>运行语音样例</button><output>{lastRecognition ? `${lastRecognition.text} · ${lastRecognition.latencyMs} ms · ${lastRecognition.engine}` : '等待合成语音输入；不启用真实麦克风'}</output></div>}
          <button className={`voice-button ${voiceState === 'listening' ? 'is-listening' : ''}`} onClick={voiceAction} disabled={!voiceSupported} aria-label={voiceState === 'starting' || voiceState === 'listening' ? '暂停语音聊天' : voiceLabel}>{voiceState === 'listening' ? <AudioLines size={24} /> : <Mic size={24} />}<span>{voiceLabel}</span></button>
          <p className="voice-hint">{voiceHint}</p><div className="input-options"><button aria-expanded={textOpen} aria-controls="text-composer" onClick={() => setTextOpen(value => !value)}><Keyboard size={16} />{textOpen ? '收起文字输入' : '也可以打字'}</button>{voiceState !== 'off' ? <button onClick={() => { speech.current?.stop(); cancelTurn(); }}><MicOff size={15} />结束语音</button> : busy && <button onClick={interrupt}>打断回应</button>}</div>
          {textOpen && <form id="text-composer" className="text-composer" onSubmit={event => { event.preventDefault(); void submit(draft); }}><label className="sr-only" htmlFor="chat-input">输入对话内容</label><textarea id="chat-input" ref={textInput} value={draft} maxLength={1500} placeholder="例如：想批量制作产品讲解视频，需要准备什么？" rows={2} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(draft); } }} /><button aria-label="发送" disabled={!draft.trim()} type="submit"><ArrowUp size={20} /></button><span>Enter 发送 · Shift + Enter 换行</span></form>}
          {mode === 'preview' && <p className="demo-note">本地演示模式 · 可在设置中连接 Jev</p>}
        </div>
      </section>
    </main>
    <footer><span>XTASY STUDIO</span><p>有空就聊两句，停下来也没关系。</p><span>VOICE FIRST</span></footer>
    <dialog ref={dialog} className={`studio-dialog ${panel === 'library' ? 'library-dialog' : ''}`} onCancel={() => setPanel(null)} onClose={() => setPanel(null)} onClick={event => { if (event.target === event.currentTarget) setPanel(null); }} aria-labelledby="dialog-title">
      <div className="dialog-content"><div className="dialog-heading"><div><span className="eyebrow">YOUR STUDIO</span><h2 id="dialog-title">{panel === 'library' ? '小岚的内容库' : '工作室设置'}</h2></div><button className="icon-button" aria-label="关闭窗口" onClick={() => setPanel(null)}><X size={20} /></button></div>
        {panel === 'library' ? <><p className="dialog-intro">{readyAssets.length} 段视频已就绪。选择一段，听听小岚怎么说。</p><label className="search-box"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索话题或台词" aria-label="搜索内容库" /></label><div className="clip-grid">{visible.map(clip => <button className="clip-card" key={clip.id} onClick={() => audition(clip)} disabled={!catalog.assets.some(asset => asset.clipId === clip.id && (mode === 'preview' || asset.status === 'ready'))}><span className="clip-category">{clip.category}<span>{clip.duration}s</span></span><h3>{clip.title}</h3><p>{clip.text || '安静陪伴，自然眨眼与轻微动作。'}</p><span className="clip-play"><Play size={13} />播放这段</span></button>)}</div>{visible.length === 0 && <p className="empty-search">没有找到这个话题，试试「制作」或「接入」。</p>}<details className="advanced"><summary>制作与导出</summary><p>先验收代表样片，再使用 RunningHub 批量生成，最后通过 Hypit 统一导出。制作命令会使用你配置的账户额度，详见项目 README。</p><code>npm run production:plan</code><code>npm run production:batch</code><button className="text-button" onClick={() => saveJson('xtasy-catalog.json', catalog)}><ArrowDownToLine size={15} />导出台词与素材清单</button></details></>
          : <><p className="dialog-intro">语音聊天会在回应结束后自动继续倾听。切到后台或打开工作室时，麦克风会关闭。</p><div className="service-row"><span>回应视频</span><span><Check size={15} />{readyAssets.length} / {catalog.clips.length} 已就绪</span></div><div className="service-row"><span>本地语音识别</span><span>{status?.asr?.state === 'ready' ? 'Whisper 已就绪' : status?.asr?.state === 'starting' ? '模型准备中' : '需要配置'}</span></div><div className="service-row"><span>Jev 语义判断</span><span>{status?.jevVerified || decision?.engine === 'jev' ? '已连接' : status?.jev ? '已配置' : '未配置'}</span></div><label className="mode-switch">对话模式<select value={mode} onChange={event => { cancelTurn(); setMode(event.target.value as 'preview' | 'live'); }}><option value="live">Jev 语义判断</option><option value="preview">本地关键词演示</option></select></label><details className="advanced"><summary>连接与判断详情</summary><p>在服务端 .env 设置 TYPESAFE_API_KEY 即可连接 Jev。重新制作视频还需要 RUNNINGHUB_API_KEY。凭证不会发送到浏览器。</p><p>浏览器只录音，本机 Whisper 负责转文字，随后由 Jev 选择视频。小岚回应时暂停收音；点击「打断并说话」可以接话。录音不落盘，对话文字仍会发给 Jev。</p>{decision && <dl><dt>最近选片</dt><dd>{decision.clipId ?? '无匹配'}</dd><dt>判断耗时</dt><dd>{decision.latencyMs} ms</dd><dt>引擎</dt><dd>{decision.model || decision.engine}</dd></dl>}<a href="https://github.com/hypit-ai/hypit" target="_blank" rel="noreferrer">Hypit 项目 <ChevronRight size={13} /></a></details></>}
      </div>
    </dialog>
  </div>;
}
