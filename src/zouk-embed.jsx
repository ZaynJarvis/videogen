import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const CONFIG = {
  serverUrl: (import.meta.env.VITE_ZOUK_SERVER_URL || 'https://zouk.zaynjarvis.com').replace(/\/+$/, ''),
  workspaceId: import.meta.env.VITE_ZOUK_WORKSPACE_ID || 'zayn',
  channel: (import.meta.env.VITE_ZOUK_CHANNEL || 'studio').replace(/^#/, ''),
  guestName: import.meta.env.VITE_ZOUK_GUEST_NAME || 'studio-reader',
};

const BROWSER_ID_KEY = 'studio.zouk.browserId';

function browserAvailable() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function compactText(text = '', limit = 900) {
  return String(text).trim().replace(/\s+/g, ' ').slice(0, limit);
}

function escapeContextText(text = '', limit = 900) {
  return compactText(text, limit)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeContextText(text = '') {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function currentStudioSelectionText() {
  if (!browserAvailable()) return '';
  const selection = window.getSelection?.();
  const text = compactText(selection?.toString() || '');
  if (!text || !selection?.rangeCount) return '';

  const app = document.querySelector('.main') || document.body;
  if (!app || !selection.anchorNode || !selection.focusNode) return '';
  if (!app.contains(selection.anchorNode) || !app.contains(selection.focusNode)) return '';
  if (document.querySelector('.zouk-studio-panel')?.contains(selection.anchorNode)) return '';
  return text;
}

function createBrowserId() {
  if (browserAvailable() && window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function getBrowserId() {
  if (!browserAvailable()) return '';
  try {
    const existing = window.localStorage.getItem(BROWSER_ID_KEY);
    if (existing) return existing;
    const next = createBrowserId();
    window.localStorage.setItem(BROWSER_ID_KEY, next);
    return next;
  } catch {
    return createBrowserId();
  }
}

function currentSourceUrl() {
  if (!browserAvailable()) return 'https://studio.zaynjarvis.com/';
  return window.location.href;
}

function currentGuestPictureUrl() {
  if (!browserAvailable()) return 'https://studio.zaynjarvis.com/favicon.svg';
  try {
    return new URL('/favicon.svg', window.location.origin).toString();
  } catch {
    return 'https://studio.zaynjarvis.com/favicon.svg';
  }
}

function wsUrlFor(serverUrl, token, workspaceId) {
  const url = new URL('/ws', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('workspaceId', workspaceId);
  return url.toString();
}

async function parseJsonResponse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || body?.error || `Request failed (${res.status})`);
  return body;
}

function normalizeAvatarUrl(value = '') {
  const src = String(value || '').trim();
  if (!src) return '';
  return /^(https?:\/\/|data:image\/)/i.test(src) ? src : '';
}

function normalizeMessage(message) {
  if (!message) return null;
  const rawReplies = Array.isArray(message.replies) ? message.replies : [];
  return {
    id: message.id || message.messageId,
    content: message.content || '',
    senderName: message.senderName || message.sender_name || 'unknown',
    senderType: message.senderType || message.sender_type || 'human',
    createdAt: message.createdAt || message.timestamp || new Date().toISOString(),
    channelName: message.channelName || message.channel_name || '',
    channelType: message.channelType || message.channel_type || 'channel',
    parentChannelName: message.parentChannelName || message.parent_channel_name || '',
    replyCount: Number(message.replyCount ?? message.reply_count ?? rawReplies.length) || 0,
    replies: rawReplies.map(normalizeMessage).filter(Boolean),
    avatarUrl: normalizeAvatarUrl(
      message.senderPicture
        || message.sender_picture
        || message.senderAvatarUrl
        || message.sender_avatar_url
        || message.picture
        || message.avatarUrl
        || message.avatar_url
        || '',
    ),
  };
}

function normalizeAgent(agent) {
  if (!agent?.id) return null;
  return {
    id: String(agent.id),
    name: String(agent.name || agent.id),
    displayName: String(agent.displayName || agent.display_name || agent.name || agent.id),
    avatarUrl: normalizeAvatarUrl(agent.picture || agent.avatarUrl || agent.avatar_url || ''),
    status: String(agent.status || 'inactive'),
    activity: String(agent.activity || '').toLowerCase(),
    activityDetail: String(agent.activityDetail || agent.activity_detail || '').trim(),
  };
}

function isSystemMessage(message) {
  return message?.senderType === 'system' || message?.senderName === 'system';
}

function mergeMessage(messages, incoming) {
  if (!incoming?.id || isSystemMessage(incoming)) return messages;
  if (messages.some((message) => message.id === incoming.id)) return messages;
  return [...messages, incoming].slice(-120);
}

function mergeThreadReply(messages, reply) {
  if (!reply?.id || isSystemMessage(reply)) return messages;
  return messages.map((message) => {
    const replies = Array.isArray(message.replies) ? message.replies : [];
    if (replies.some((item) => item.id === reply.id)) return message;
    if (reply.channelType !== 'thread') return message;
    if (reply.parentChannelName && reply.parentChannelName !== CONFIG.channel) return message;
    if (!String(reply.channelName || '').includes(String(message.id || '').slice(0, 8))) return message;
    return { ...message, replies: [...replies, reply].slice(-3), replyCount: Math.max((message.replyCount || 0) + 1, replies.length + 1) };
  });
}

function mergeAgents(current, incoming) {
  const next = new Map(current.map((agent) => [agent.id, agent]));
  const list = Array.isArray(incoming) ? incoming : [incoming];
  list.forEach((raw) => {
    const agent = normalizeAgent(raw);
    if (!agent) return;
    next.set(agent.id, { ...next.get(agent.id), ...agent });
  });
  return [...next.values()].sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
}

function updateAgentActivity(agents, packet) {
  if (!packet?.agentId) return agents;
  return agents.map((agent) => (
    agent.id === packet.agentId
      ? { ...agent, activity: String(packet.activity || agent.activity || '').toLowerCase(), activityDetail: String(packet.detail || '').trim() || agent.activityDetail }
      : agent
  ));
}

function updateAgentStatus(agents, packet) {
  if (!packet?.agentId) return agents;
  if (packet.status === 'deleted') return agents.filter((agent) => agent.id !== packet.agentId);
  return agents.map((agent) => (
    agent.id === packet.agentId ? { ...agent, status: String(packet.status || agent.status) } : agent
  ));
}

function agentDotStatus(agent) {
  if (!agent || agent.status !== 'active') return 'offline';
  if (['working', 'thinking', 'error', 'online'].includes(agent.activity)) return agent.activity;
  return 'online';
}

function escapeContextAttr(value = '', limit = 1600) {
  return compactText(value, limit)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildMcpDeliveryBlock(mcp, sourceImage, improvement) {
  const endpoint = compactText(mcp?.endpoint, 1600);
  const token = compactText(mcp?.token, 200);
  const kind = compactText(mcp?.kind, 40) || 'zone';
  const tool = compactText(mcp?.tool, 120) || (kind === 'sheet' ? 'deliver_character_sheet' : 'deliver_character_zone');
  if (!endpoint || !token) return null;
  const lines = [];
  if (sourceImage) lines.push(`  <source-image>${escapeContextText(sourceImage, 1600)}</source-image>`);
  if (improvement) lines.push(`  <improvement>${escapeContextText(improvement)}</improvement>`);
  lines.push(`  <deliver-via-mcp endpoint="${escapeContextAttr(endpoint)}" token="${escapeContextAttr(token, 200)}" tool="${escapeContextAttr(tool, 120)}" kind="${escapeContextAttr(kind, 40)}">`);
  if (kind === 'sheet') {
    const zones = Array.isArray(mcp?.zones) ? mcp.zones : [];
    const rows = Number(mcp?.grid?.rows) || 3;
    const cols = Number(mcp?.grid?.cols) || 3;
    const zoneLines = zones.map((zone, index) => `  ${index + 1}. ${escapeContextText(zone?.id || zone?.zone_id || '', 80)} — ${escapeContextText(zone?.prompt || zone?.label || zone?.role || '', 200)}`);
    const zoneIds = zones.map((zone) => compactText(zone?.id || zone?.zone_id || '', 80)).filter(Boolean).join(', ');
    if (zoneLines.length) {
      lines.push(`  Zones (in order, grid ${rows}x${cols}):`);
      zoneLines.forEach((zoneLine) => lines.push(zoneLine));
    }
    lines.push(`  Steps for you, the agent: (1) use your imagegen tool to produce ${zones.length || rows * cols} consistent identity views of the SAME subject from source-image (you may compose them as one ${rows}x${cols} contact sheet); (2) upload to a public URL (your cloud); (3) call the MCP server at endpoint, Authorization: Bearer &lt;token&gt;, JSON-RPC tools/call, EITHER (a) name "deliver_character_sheet" arguments { "claim_token":"&lt;token&gt;", "sheet_image_url":"&lt;your public ${rows}x${cols} sheet url&gt;" } and Studio will crop it into the zones, OR (b) name "deliver_character_zone" arguments { "claim_token":"&lt;token&gt;", "zone_id":"&lt;zone id&gt;", "image_url":"&lt;your public url&gt;" } once per zone using these zone ids: [${escapeContextText(zoneIds, 600)}]. The token covers all zones until done and expires in 30 min.`);
  } else {
    lines.push('  Steps for you, the agent: (1) use your imagegen tool with the source-image and the improvement to produce the improved image; (2) upload it to a public URL (your cloud); (3) call the MCP server at endpoint, Authorization: Bearer &lt;token&gt;, JSON-RPC tools/call name "deliver_character_zone" arguments { "claim_token":"&lt;token&gt;", "image_url":"&lt;your public url&gt;" }. The token is single-use and expires in 30 min. Deliver exactly one final image.');
  }
  lines.push('  </deliver-via-mcp>');
  return lines.join('\n');
}

function buildInjectedContext(sourceUrl, referencedText, includeUrl, mcp, sourceImage, improvement) {
  const mcpBlock = buildMcpDeliveryBlock(mcp, sourceImage, improvement);
  const lines = ['<zouk-context>'];
  if (mcpBlock) {
    lines.push(mcpBlock);
  } else {
    if (includeUrl) lines.push(`  <url>${escapeContextText(sourceUrl, 1600)}</url>`);
    const reference = compactText(referencedText);
    if (reference) lines.push(`  <referenced-text>${escapeContextText(reference)}</referenced-text>`);
  }
  lines.push('</zouk-context>');
  return lines.join('\n');
}

function messageWithInjectedContext(message, sourceUrl, referencedText, includeUrl, shouldInject, mcp, sourceImage, improvement) {
  const trimmed = message.trim();
  if (!shouldInject) return trimmed;
  return `${buildInjectedContext(sourceUrl, referencedText, includeUrl, mcp, sourceImage, improvement)}\n\n${trimmed}`;
}

function parseInjectedMessage(content) {
  const text = String(content || '');
  const xmlMatch = text.match(/^<zouk-context>\n?([\s\S]*?)\n?<\/zouk-context>\n*/i);
  if (!xmlMatch) return { context: null, body: text };
  const markup = xmlMatch[1];
  const readTag = (tag) => {
    const tagMatch = markup.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return tagMatch ? unescapeContextText(tagMatch[1].trim()) : '';
  };
  const mcpMatch = markup.match(/<deliver-via-mcp\b([^>]*)>/i);
  const readAttr = (attr) => {
    if (!mcpMatch) return '';
    const attrMatch = mcpMatch[1].match(new RegExp(`${attr}="([^"]*)"`, 'i'));
    return attrMatch ? unescapeContextText(attrMatch[1].trim()) : '';
  };
  const context = [
    { key: 'url', value: readTag('url') },
    { key: 'referenced', value: readTag('referenced-text') },
    { key: 'source-image', value: readTag('source-image') },
    { key: 'improvement', value: readTag('improvement') },
    { key: 'deliver-via-mcp', value: readAttr('endpoint') },
  ].filter((item) => item.value);
  return { context: context.length ? context : null, body: text.slice(xmlMatch[0].length).trimStart() };
}

function shouldSubmitOnEnter(event) {
  const nativeEvent = event?.nativeEvent || event || {};
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && !nativeEvent.isComposing
    && event.keyCode !== 229;
}

function avatarLabel(name) {
  const clean = String(name || 's').replace(/^@/, '').trim();
  return (clean[0] || 's').toUpperCase();
}

function Avatar({ name, src, status = '', kind = 'human' }) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc = !imageFailed ? normalizeAvatarUrl(src) : '';
  return (
    <div className={`zouk-studio-avatar is-${kind}${status ? ` is-${status}` : ''}${imageSrc ? ' has-image' : ''}`} aria-hidden="true">
      {imageSrc ? <img src={imageSrc} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} /> : avatarLabel(name)}
      {status ? <span className="zouk-studio-avatar-dot" /> : null}
    </div>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
    </svg>
  );
}

function MessageBody({ content }) {
  const parsed = parseInjectedMessage(content);
  return (
    <>
      {parsed.context ? (
        <div className="zouk-studio-message-context">
          {parsed.context.map((item) => (
            <div className="zouk-studio-message-context-row" key={`${item.key}:${item.value}`}>
              <span>{item.key}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {parsed.body ? <div className="zouk-studio-message-text">{parsed.body}</div> : null}
    </>
  );
}

function ContextPreview({ sourceUrl, referencedText, includeUrl }) {
  const reference = compactText(referencedText, 180);
  return (
    <div className="zouk-studio-context-preview" aria-label="Injected context">
      {includeUrl ? <div><span>url</span><strong>{sourceUrl}</strong></div> : null}
      {reference ? <div><span>referenced</span><strong>{reference}</strong></div> : null}
    </div>
  );
}

function LiveAgents({ agents }) {
  const live = agents.filter((agent) => agent.status === 'active').slice(0, 4);
  if (!live.length) return null;
  return (
    <div className="zouk-studio-live">
      <span>LIVE</span>
      {live.map((agent) => (
        <div className="zouk-studio-live-agent" key={agent.id} title={agent.activityDetail || agent.activity || 'online'}>
          <Avatar name={agent.displayName} src={agent.avatarUrl} status={agentDotStatus(agent)} kind="agent" />
          <strong>{agent.displayName}</strong>
        </div>
      ))}
    </div>
  );
}

export function ZoukStudioChat({ route }) {
  const [browserId] = useState(getBrowserId);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [userName, setUserName] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [messages, setMessages] = useState([]);
  const [agents, setAgents] = useState([]);
  const [composer, setComposer] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [sourceUrl, setSourceUrl] = useState(currentSourceUrl);
  const [lastContextUrl, setLastContextUrl] = useState('');
  const [headerSlot, setHeaderSlot] = useState(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const wsRef = useRef(null);
  const pendingAutoSendRef = useRef(null);
  const target = `#${CONFIG.channel}`;
  const referencedText = compactText(selectedText);
  const includeContextUrl = Boolean(sourceUrl && (sourceUrl !== lastContextUrl || referencedText));
  const shouldInjectContext = includeContextUrl || Boolean(referencedText);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Workspace-Id': CONFIG.workspaceId,
  }), [token]);

  const visibleMessages = useMemo(
    () => messages.filter((message) => !isSystemMessage(message)),
    [messages],
  );

  const rememberSource = useCallback(() => {
    const next = currentSourceUrl();
    setSourceUrl(next);
    return next;
  }, []);

  const loadHistory = useCallback(async (nextToken = token) => {
    if (!nextToken) return;
    const res = await fetch(`${CONFIG.serverUrl}/api/messages`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${nextToken}`,
        'X-Workspace-Id': CONFIG.workspaceId,
        'X-Channel': target,
        'X-Limit': '80',
      },
      cache: 'no-store',
    });
    const body = await parseJsonResponse(res);
    setMessages((body.messages || []).map(normalizeMessage).filter((message) => message && !isSystemMessage(message)));
  }, [target, token]);

  const connect = useCallback(async () => {
    if (!browserId || status === 'connecting') return;
    setStatus('connecting');
    setError('');
    try {
      const res = await fetch(`${CONFIG.serverUrl}/api/auth/embed-guest-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: CONFIG.workspaceId,
          channel: CONFIG.channel,
          name: CONFIG.guestName,
          browserId,
          picture: currentGuestPictureUrl(),
        }),
      });
      const body = await parseJsonResponse(res);
      setToken(body.token);
      setUserName(body.user?.name || CONFIG.guestName);
      await loadHistory(body.token);
      setStatus('connected');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Unable to connect');
    }
  }, [browserId, loadHistory, status]);

  const openChat = useCallback(() => {
    rememberSource();
    setSelectedText(currentStudioSelectionText());
    setOpen(true);
    window.setTimeout(() => textareaRef.current?.focus(), 80);
  }, [rememberSource]);

  const toggleChat = useCallback(() => {
    if (open) setOpen(false);
    else openChat();
  }, [open, openChat]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setHeaderSlot(document.getElementById('zouk-studio-chat-slot'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open || token || status === 'connecting' || status === 'error') return undefined;
    const timer = window.setTimeout(() => connect(), 0);
    return () => window.clearTimeout(timer);
  }, [connect, open, status, token]);

  useEffect(() => {
    if (!token) return undefined;
    const ws = new WebSocket(wsUrlFor(CONFIG.serverUrl, token, CONFIG.workspaceId));
    wsRef.current = ws;
    ws.onopen = () => setStatus('connected');
    ws.onclose = () => setStatus((prev) => (prev === 'error' ? prev : 'closed'));
    ws.onerror = () => setStatus('error');
    ws.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.type === 'ping') return;
        if (packet.type === 'init') {
          setAgents(mergeAgents([], packet.agents || []));
          return;
        }
        if (packet.type === 'agent_started' && packet.agent) {
          setAgents((prev) => mergeAgents(prev, packet.agent));
          return;
        }
        if (packet.type === 'agent_status') {
          setAgents((prev) => updateAgentStatus(prev, packet));
          return;
        }
        if (packet.type === 'agent_activity') {
          setAgents((prev) => updateAgentActivity(prev, packet));
          return;
        }
        if ((packet.type === 'message' || packet.type === 'new_message') && packet.message) {
          const next = normalizeMessage(packet.message);
          if (next?.channelType === 'thread') {
            setMessages((prev) => mergeThreadReply(prev, next));
          } else if (next?.channelName === CONFIG.channel) {
            setMessages((prev) => mergeMessage(prev, next));
          }
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    return () => {
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [token]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visibleMessages.length, open]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = '0px';
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 40), 120)}px`;
  }, [composer, open]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelectedText('');
      setSourceUrl(currentSourceUrl());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [route?.path]);

  const sendComposedMessage = useCallback(async (rawMessage, context = {}) => {
    const trimmed = String(rawMessage || '').trim();
    if (!trimmed || !token || status === 'sending') return;
    const nextSourceUrl = context.sourceUrl || rememberSource();
    const nextReferencedText = compactText(context.referencedText ?? selectedText);
    const nextMcp = context.mcp || null;
    const hasMcp = Boolean(nextMcp?.endpoint && nextMcp?.token);
    const nextSourceImage = compactText(context.sourceImage || '', 1600);
    const nextImprovement = compactText(context.improvement || '');
    const nextIncludeUrl = Boolean(nextSourceUrl && (nextSourceUrl !== lastContextUrl || nextReferencedText));
    const content = messageWithInjectedContext(
      trimmed,
      nextSourceUrl,
      nextReferencedText,
      nextIncludeUrl,
      hasMcp || nextIncludeUrl || Boolean(nextReferencedText),
      hasMcp ? nextMcp : null,
      nextSourceImage,
      nextImprovement,
    );
    setStatus('sending');
    setError('');
    try {
      const res = await fetch(`${CONFIG.serverUrl}/api/messages`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ target, content }),
      });
      const body = await parseJsonResponse(res);
      setMessages((prev) => mergeMessage(prev, normalizeMessage(body.message)));
      if (nextIncludeUrl) setLastContextUrl(nextSourceUrl);
      setSelectedText('');
      setComposer('');
      setStatus('connected');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Send failed');
    }
  }, [authHeaders, lastContextUrl, rememberSource, selectedText, status, target, token]);

  useEffect(() => {
    const onCompose = (event) => {
      const detail = event?.detail || {};
      const message = String(detail.message || '').trim();
      if (!message) return;
      const nextSourceUrl = detail.sourceUrl || currentSourceUrl();
      const nextReferencedText = compactText(detail.referencedText || '');
      const nextMcp = detail.mcp && detail.mcp.endpoint && detail.mcp.token ? detail.mcp : null;
      const nextSourceImage = compactText(detail.sourceImage || '', 1600);
      const nextImprovement = compactText(detail.improvement || '');

      setSourceUrl(nextSourceUrl);
      setSelectedText(nextReferencedText);
      setComposer(message);
      setOpen(true);
      if (detail.autoSend) {
        pendingAutoSendRef.current = {
          message,
          sourceUrl: nextSourceUrl,
          referencedText: nextReferencedText,
          mcp: nextMcp,
          sourceImage: nextSourceImage,
          improvement: nextImprovement,
        };
      } else {
        pendingAutoSendRef.current = null;
      }
      window.setTimeout(() => textareaRef.current?.focus(), 80);
    };
    window.addEventListener('studio:zouk-compose', onCompose);
    return () => window.removeEventListener('studio:zouk-compose', onCompose);
  }, []);

  useEffect(() => {
    const pending = pendingAutoSendRef.current;
    if (!open || !token || status === 'connecting' || status === 'sending' || !pending) return;
    pendingAutoSendRef.current = null;
    sendComposedMessage(pending.message, pending);
  }, [open, sendComposedMessage, status, token]);

  const sendMessage = useCallback(async () => {
    await sendComposedMessage(composer);
  }, [composer, sendComposedMessage]);

  const onSubmit = (event) => {
    event.preventDefault();
    sendMessage();
  };

  const launcher = (
    <button
      type="button"
      className={`zouk-studio-launcher${open ? ' is-active' : ''}`}
      aria-label={open ? 'Close studio chat' : 'Open studio chat'}
      aria-pressed={open}
      onClick={toggleChat}
    >
      <ChatIcon />
    </button>
  );

  return (
    <>
      {headerSlot ? createPortal(launcher, headerSlot) : null}
      {open ? (
        <aside className="zouk-studio-panel" aria-label="Studio chat">
          <header className="zouk-studio-panel-head">
            <div>
              <div className="mono">Zouk</div>
              <span>#{CONFIG.channel}</span>
            </div>
            <button type="button" className="zouk-studio-close" onClick={() => setOpen(false)} aria-label="Close chat">×</button>
          </header>

          <LiveAgents agents={agents} />

          <div className="zouk-studio-messages" ref={scrollRef}>
            {status === 'connecting' && !visibleMessages.length ? (
              <div className="zouk-studio-empty">Connecting to Zouk...</div>
            ) : null}
            {status === 'error' && !visibleMessages.length ? (
              <div className="zouk-studio-empty">
                <span>Zouk connection unavailable.</span>
                <button type="button" onClick={connect}>Retry</button>
              </div>
            ) : null}
            {visibleMessages.map((message) => {
              const mine = message.senderName === userName;
              return (
                <article key={message.id} className={`zouk-studio-message${mine ? ' is-mine' : ''}`}>
                  {!mine ? <Avatar name={message.senderName} src={message.avatarUrl} kind={message.senderType === 'agent' ? 'agent' : 'human'} /> : null}
                  <div className="zouk-studio-bubble-column">
                    {!mine ? <div className="zouk-studio-sender">{message.senderName}</div> : null}
                    <div className="zouk-studio-bubble">
                      <MessageBody content={message.content} />
                    </div>
                    {message.replyCount ? (
                      <div className="zouk-studio-replies">
                        {(message.replies || []).slice(-2).map((reply) => (
                          <div key={reply.id}><strong>{reply.senderName}</strong> {parseInjectedMessage(reply.content).body}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>

          <form className="zouk-studio-composer" onSubmit={onSubmit}>
            {shouldInjectContext ? <ContextPreview sourceUrl={sourceUrl} referencedText={referencedText} includeUrl={includeContextUrl} /> : null}
            <textarea
              ref={textareaRef}
              value={composer}
              rows={1}
              enterKeyHint="send"
              placeholder={token ? `Message #${CONFIG.channel}` : 'Open a Zouk session...'}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (shouldSubmitOnEnter(event)) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
            />
            {error && visibleMessages.length ? (
              <div className="zouk-studio-error">
                <span>{error}</span>
                <button type="button" onClick={connect}>Retry</button>
              </div>
            ) : null}
          </form>
        </aside>
      ) : null}
    </>
  );
}
