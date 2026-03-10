import { createIcons, SendHorizontal, Sparkles, FileText, ChevronDown, AlertCircle, BookOpen, Globe, Shield, Scale, Scroll } from 'lucide';
import { marked } from 'marked';
import markedFootnote from 'marked-footnote';

marked.setOptions({ gfm: true, breaks: true });
marked.use(markedFootnote());

const icons = { SendHorizontal, Sparkles, FileText, ChevronDown, AlertCircle, BookOpen, Globe, Shield, Scale, Scroll };

const WELCOME_MESSAGE = `Welcome to VitBot — your guide to the Free Republic of Liberland.\n\nI can answer questions about governance, blockchain infrastructure, constitutional law, diplomatic relations, citizenship, and more. Ask me anything.`;

const SUGGESTED_QUESTIONS = [
  { text: "How does Liberland's meritocracy work?", icon: "shield" },
  { text: "What is the Liberland blockchain?", icon: "globe" },
  { text: "How do I become a citizen?", icon: "book-open" },
  { text: "Tell me about the constitution", icon: "sparkles" },
  { text: "What are Liberland's criminal laws?", icon: "scroll" },
  { text: "How does the judiciary work?", icon: "scale" },
];

function renderMarkdown(text) {
  return marked.parse(text);
}

class VitBot {
  constructor() {
    this.messages = [];
    this.isStreaming = false;
    this.abortController = null;
    this.init();
  }

  init() {
    const app = document.getElementById('app');
    app.innerHTML = this.buildLayout();
    createIcons({ icons });
    this.bindElements();
    this.bindEvents();
    this.addBotMessage(WELCOME_MESSAGE, true);
  }

  buildLayout() {
    return `
      <div class="flex flex-col h-screen max-h-screen bg-bg">

        <!-- Header with input -->
        <header class="flex-shrink-0 px-5 sm:px-8 pt-5 pb-4 border-b border-border header-animate" style="background: linear-gradient(180deg, rgba(20,20,30,0.95) 0%, rgba(7,7,12,0.98) 100%);">
          <div class="max-w-[72rem] mx-auto">
            <div class="flex items-center gap-4 mb-4">
              <div class="header-avatar relative w-14 h-14 rounded-2xl overflow-hidden flex-shrink-0">
                <img src="/media/vit-borg.png" alt="VitBot" class="w-full h-full object-cover" />
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2.5">
                  <h1 class="text-xl font-bold text-white tracking-tight" style="font-family: var(--font-display);">VitBot</h1>
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-widest uppercase border" style="color: var(--color-cyan); border-color: var(--color-cyan-dim); background: var(--color-cyan-dim);">
                    <i data-lucide="sparkles" class="w-2.5 h-2.5"></i>
                    LIVE
                  </span>
                </div>
                <p class="text-[11px] tracking-wide uppercase mt-0.5" style="color: rgba(197, 165, 78, 0.5); font-family: var(--font-display); letter-spacing: 0.15em;">Liberland Intelligence</p>
              </div>
            </div>
            <div class="input-area relative">
              <textarea
                id="chatInput"
                rows="3"
                placeholder="Ask about Liberland..."
                class="w-full rounded-2xl px-5 py-4 pr-16 text-sm text-white placeholder-zinc-600 resize-none outline-none transition-all duration-300 max-h-48"
                style="background: var(--color-surface-raised); border: 1px solid var(--color-border); font-family: var(--font-body);"
              ></textarea>
              <button
                id="sendBtn"
                class="send-btn absolute right-3 bottom-3 w-10 h-10 rounded-xl flex items-center justify-center cursor-pointer"
                style="background: rgba(197, 165, 78, 0.15); border: 1px solid rgba(197, 165, 78, 0.3); color: var(--color-gold);"
              >
                <i data-lucide="send-horizontal" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        </header>

        <!-- Chat area -->
        <main id="chatArea" class="flex-1 overflow-y-auto topo-bg px-5 sm:px-8 py-8" style="scroll-behavior: smooth;">
          <div id="messages" class="max-w-[72rem] mx-auto space-y-5"></div>
        </main>

        <!-- Footer -->
        <footer class="flex-shrink-0 border-t border-border px-5 sm:px-8 py-2.5" style="background: rgba(7,7,12,0.98);">
          <p class="text-center text-[10px] tracking-wider uppercase" style="color: rgba(200,200,212,0.2); font-family: var(--font-display);">Powered by Liberland docs & presidential speeches</p>
        </footer>

      </div>
    `;
  }

  bindElements() {
    this.chatArea = document.getElementById('chatArea');
    this.messagesEl = document.getElementById('messages');
    this.input = document.getElementById('chatInput');
    this.sendBtn = document.getElementById('sendBtn');
  }

  bindEvents() {
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = Math.min(this.input.scrollHeight, 192) + 'px';
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    this.sendBtn.addEventListener('click', () => this.handleSend());
  }

  handleSend() {
    const text = this.input.value.trim();
    if (!text || this.isStreaming) return;
    this.isStreaming = true;
    this.input.disabled = true;
    this.input.value = '';
    this.input.style.height = 'auto';
    this.sendMessage(text);
  }

  sendMessage(text) {
    this.removeSuggestedQuestions();
    this.addUserMessage(text);
    this.messages.push({ role: 'user', content: text });
    this.streamResponse(text);
  }

  addUserMessage(text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex justify-end message-appear';
    wrapper.innerHTML = `
      <div class="max-w-[80%] sm:max-w-[70%]">
        <div class="user-bubble rounded-2xl rounded-br-sm px-5 py-3 text-sm font-medium leading-relaxed">
          ${this.escapeHtml(text)}
        </div>
      </div>
    `;
    this.messagesEl.appendChild(wrapper);
    this.scrollToBottom();
  }

  botAvatar() {
    return `<div class="avatar-ring relative flex-shrink-0 w-10 h-10 rounded-xl overflow-hidden mt-0.5">
      <img src="/media/vit-borg.png" alt="VitBot" class="w-full h-full object-cover" />
    </div>`;
  }

  addBotMessage(text, isWelcome = false) {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex gap-3.5 message-appear';

    const contentHtml = renderMarkdown(text);

    wrapper.innerHTML = `
      ${this.botAvatar()}
      <div class="max-w-[85%] sm:max-w-[78%] min-w-0">
        <div class="glass-card rounded-2xl rounded-tl-sm px-5 py-4 text-sm leading-relaxed" style="color: #c8c8d4;">
          <div class="bot-message-content">${contentHtml}</div>
        </div>
      </div>
    `;

    this.messagesEl.appendChild(wrapper);
    createIcons({ icons, nameAttr: 'data-lucide' });

    if (isWelcome) {
      this.addSuggestedQuestions();
    }

    this.scrollToBottom();
    return wrapper;
  }

  addSuggestedQuestions() {
    const container = document.createElement('div');
    container.id = 'suggestedQuestions';
    container.className = 'grid grid-cols-1 sm:grid-cols-2 gap-2.5 ml-14 mt-4';

    SUGGESTED_QUESTIONS.forEach((q) => {
      const chip = document.createElement('button');
      chip.className = 'chip flex items-center gap-2.5 text-left text-xs px-4 py-3 rounded-xl cursor-pointer transition-all duration-250';
      chip.style.cssText = 'background: var(--color-surface-raised); border: 1px solid var(--color-border); color: rgba(200,200,212,0.7); font-family: var(--font-body);';
      chip.innerHTML = `
        <i data-lucide="${q.icon}" class="w-3.5 h-3.5 flex-shrink-0" style="color: var(--color-gold-dim);"></i>
        <span>${q.text}</span>
      `;

      chip.addEventListener('mouseenter', () => {
        chip.style.borderColor = 'rgba(197, 165, 78, 0.25)';
        chip.style.background = 'rgba(197, 165, 78, 0.05)';
        chip.style.color = 'var(--color-gold-bright)';
      });
      chip.addEventListener('mouseleave', () => {
        chip.style.borderColor = 'var(--color-border)';
        chip.style.background = 'var(--color-surface-raised)';
        chip.style.color = 'rgba(200,200,212,0.7)';
      });

      chip.addEventListener('click', () => this.sendMessage(q.text));
      container.appendChild(chip);
    });

    this.messagesEl.appendChild(container);
    createIcons({ icons, nameAttr: 'data-lucide' });
    this.scrollToBottom();
  }

  removeSuggestedQuestions() {
    const el = document.getElementById('suggestedQuestions');
    if (el) el.remove();
  }

  addTypingIndicator() {
    const wrapper = document.createElement('div');
    wrapper.id = 'typingIndicator';
    wrapper.className = 'flex gap-3.5 message-appear';
    wrapper.innerHTML = `
      ${this.botAvatar()}
      <div class="glass-card rounded-2xl rounded-tl-sm px-5 py-4">
        <div class="flex gap-2 items-center h-5">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </div>
      </div>
    `;
    this.messagesEl.appendChild(wrapper);
    this.scrollToBottom();
  }

  removeTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
  }

  createStreamingBotMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex gap-3.5 message-appear';
    wrapper.innerHTML = `
      ${this.botAvatar()}
      <div class="max-w-[85%] sm:max-w-[78%] min-w-0 streaming-message-container">
        <div class="glass-card rounded-2xl rounded-tl-sm px-5 py-4 text-sm leading-relaxed" style="color: #c8c8d4;">
          <div class="bot-message-content"></div>
        </div>
      </div>
    `;
    this.messagesEl.appendChild(wrapper);
    return wrapper;
  }

  async streamResponse(text) {
    this.isStreaming = true;
    this.input.disabled = true;
    this.addTypingIndicator();

    const history = this.messages.slice(-10);

    try {
      this.abortController = new AbortController();
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      this.removeTypingIndicator();
      const msgEl = this.createStreamingBotMessage();
      const contentEl = msgEl.querySelector('.bot-message-content');

      let fullText = '';
      let sources = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);

            if (parsed.type === 'token' && parsed.content) {
              fullText += parsed.content;
              contentEl.innerHTML = renderMarkdown(fullText);
              this.scrollToBottom();
            } else if (parsed.type === 'sources' && parsed.sources) {
              sources = parsed.sources;
            } else if (parsed.type === 'error') {
              const errMsg = parsed.message || 'Something went wrong';
              throw Object.assign(new Error(errMsg), { _isStreamError: true });
            }
          } catch (e) {
            if (e._isStreamError) {
              throw e;
            }
            // skip JSON parse errors on partial data
          }
        }
      }

      this.messages.push({ role: 'assistant', content: fullText });

      if (sources.length > 0) {
        this.addSourcesSection(msgEl.querySelector('.streaming-message-container'), sources);
      }
    } catch (error) {
      this.removeTypingIndicator();
      if (error.name !== 'AbortError') {
        this.addErrorMessage(error.message || 'Something went wrong. Please try again.');
      }
    } finally {
      this.isStreaming = false;
      this.input.disabled = false;
      this.input.focus();
    }
  }

  addSourcesSection(container, sources) {
    const uniqueSources = sources.filter((s, i, arr) =>
      arr.findIndex(x => x.title === s.title && x.section === s.section) === i
    );

    const sourcesEl = document.createElement('div');
    sourcesEl.className = 'mt-3';
    sourcesEl.innerHTML = `
      <button class="sources-toggle flex items-center gap-2 text-[11px] tracking-wide uppercase py-1.5 cursor-pointer transition-colors duration-200" style="color: rgba(200,200,212,0.3); font-family: var(--font-display);">
        <i data-lucide="file-text" class="w-3 h-3"></i>
        <span>${uniqueSources.length} source${uniqueSources.length !== 1 ? 's' : ''} referenced</span>
        <i data-lucide="chevron-down" class="w-3 h-3 toggle-icon transition-transform duration-300"></i>
      </button>
      <div class="sources-content">
        <div>
          <div class="space-y-2 pt-2.5">
            ${uniqueSources.map((s) => `
              <div class="source-card text-xs rounded-xl px-4 py-2.5" style="background: rgba(0,0,0,0.25); border: 1px solid var(--color-border);">
                <div class="flex items-center gap-2" style="color: var(--color-gold-dim);">
                  <i data-lucide="file-text" class="w-3 h-3 flex-shrink-0"></i>
                  <span class="font-medium truncate" style="color: var(--color-gold); font-family: var(--font-display);">${this.escapeHtml(s.title || 'Document')}</span>
                </div>
                <div class="flex items-center gap-2 mt-1 ml-5">
                  <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold" style="${s.source_type === 'transcript' ? 'color: var(--color-cyan); background: var(--color-cyan-dim);' : 'color: var(--color-gold-dim); background: rgba(197,165,78,0.08);'}">${s.source_type === 'transcript' ? 'Speech' : 'Doc'}</span>
                  ${s.section ? `<span style="color: rgba(200,200,212,0.25);">·</span><span class="truncate" style="color: rgba(200,200,212,0.35);">${this.escapeHtml(s.section)}</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    container.appendChild(sourcesEl);
    createIcons({ icons, nameAttr: 'data-lucide' });

    const toggle = sourcesEl.querySelector('.sources-toggle');
    const content = sourcesEl.querySelector('.sources-content');
    const icon = sourcesEl.querySelector('.toggle-icon');

    toggle.addEventListener('mouseenter', () => toggle.style.color = 'rgba(200,200,212,0.5)');
    toggle.addEventListener('mouseleave', () => toggle.style.color = content.classList.contains('expanded') ? 'rgba(200,200,212,0.5)' : 'rgba(200,200,212,0.3)');

    toggle.addEventListener('click', () => {
      const isExpanded = content.classList.toggle('expanded');
      icon.style.transform = isExpanded ? 'rotate(180deg)' : '';
    });

    this.scrollToBottom();
  }

  addErrorMessage(text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'flex gap-3.5 message-appear';
    wrapper.innerHTML = `
      <div class="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center mt-0.5" style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15);">
        <i data-lucide="alert-circle" class="w-4 h-4" style="color: #ef4444;"></i>
      </div>
      <div class="max-w-[80%]">
        <div class="rounded-2xl rounded-tl-sm px-5 py-3.5 text-sm" style="background: rgba(239, 68, 68, 0.04); border: 1px solid rgba(239, 68, 68, 0.1); color: #fca5a5;">
          ${this.escapeHtml(text)}
        </div>
      </div>
    `;
    this.messagesEl.appendChild(wrapper);
    createIcons({ icons, nameAttr: 'data-lucide' });
    this.scrollToBottom();
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      this.chatArea.scrollTop = this.chatArea.scrollHeight;
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

new VitBot();
