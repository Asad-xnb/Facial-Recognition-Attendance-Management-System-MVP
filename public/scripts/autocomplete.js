/**
 * Enterprise Searchable Autocomplete Combobox
 * Replaces clunky <select> dropdowns with fast, keyboard-navigable search-as-you-type.
 * Scalable to thousands of records with zero DOM lag.
 */
class SearchableSelect {
  constructor(config) {
    this.container = typeof config.container === 'string' 
      ? document.getElementById(config.container) 
      : config.container;

    if (!this.container) {
      console.warn('SearchableSelect: container element not found', config.container);
      return;
    }

    this.id = config.id || 'searchable_' + Math.random().toString(36).substr(2, 9);
    this.name = config.name || '';
    this.placeholder = config.placeholder || 'Type to search...';
    this.data = config.data || []; // Array of { id, title, subtitle, badge }
    this.value = config.value !== undefined ? String(config.value) : '';
    this.onChange = config.onChange || null;
    this.emptyMessage = config.emptyMessage || 'No matching records found';
    this.maxResults = config.maxResults || 8;
    this.allowClear = config.allowClear !== false;
    this.clearLabel = config.clearLabel || 'Unassigned / Clear';

    this.isOpen = false;
    this.highlightIndex = -1;
    this.filteredData = [];

    this.render();
    this.bindEvents();

    if (this.value) {
      this.setValue(this.value, false);
    }
  }

  setData(newData, selectedValue = null) {
    this.data = newData || [];
    if (selectedValue !== null) {
      this.setValue(selectedValue, false);
    } else {
      this.updateDisplay();
    }
  }

  render() {
    this.container.innerHTML = `
      <div class="relative w-full text-foreground searchable-select-wrapper" id="${this.id}_wrapper">
        <input type="hidden" name="${this.name}" id="${this.id}_hidden" value="${this.value}">
        
        <!-- Input display box -->
        <div class="relative flex items-center">
          <div class="absolute left-3.5 text-muted pointer-events-none">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
          </div>
          <input 
            type="text" 
            id="${this.id}_input"
            autocomplete="off"
            spellcheck="false"
            placeholder="${this.placeholder}"
            class="w-full pl-10 pr-9 py-2.5 bg-background border border-border rounded-lg text-sm text-foreground placeholder-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all cursor-pointer"
          >
          <button 
            type="button" 
            id="${this.id}_clear"
            title="Clear selection"
            class="absolute right-2.5 text-muted hover:text-foreground p-1 rounded-md transition-colors hidden"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <!-- Floating Autocomplete Menu -->
        <div 
          id="${this.id}_menu" 
          class="hidden absolute left-0 right-0 top-full mt-1.5 bg-card border border-border rounded-xl shadow-2xl z-50 overflow-hidden max-h-64 overflow-y-auto divide-y divide-border/50 animate-in fade-in slide-in-from-top-1 duration-150"
        >
          <div id="${this.id}_list" class="p-1 space-y-0.5"></div>
        </div>
      </div>
    `;

    this.inputEl = document.getElementById(`${this.id}_input`);
    this.hiddenEl = document.getElementById(`${this.id}_hidden`);
    this.menuEl = document.getElementById(`${this.id}_menu`);
    this.listEl = document.getElementById(`${this.id}_list`);
    this.clearBtn = document.getElementById(`${this.id}_clear`);
  }

  bindEvents() {
    // Focus & Click to open
    this.inputEl.addEventListener('focus', () => {
      this.inputEl.select();
      this.filter(this.inputEl.value);
      this.open();
    });

    // Type to filter
    this.inputEl.addEventListener('input', (e) => {
      this.filter(e.target.value);
      if (!this.isOpen) this.open();
    });

    // Clear selection
    this.clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setValue('', true);
      this.inputEl.focus();
    });

    // Keyboard navigation
    this.inputEl.addEventListener('keydown', (e) => {
      if (!this.isOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
        this.open();
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.highlight(this.highlightIndex + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.highlight(this.highlightIndex - 1);
          break;
        case 'Enter':
          e.preventDefault();
          if (this.highlightIndex >= 0 && this.filteredData[this.highlightIndex]) {
            this.selectItem(this.filteredData[this.highlightIndex]);
          } else if (this.filteredData.length > 0) {
            this.selectItem(this.filteredData[0]);
          }
          break;
        case 'Escape':
          this.close();
          break;
      }
    });

    // Click outside detection
    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById(`${this.id}_wrapper`);
      if (wrapper && !wrapper.contains(e.target)) {
        this.close();
      }
    });
  }

  filter(query = '') {
    const q = (query || '').trim().toLowerCase();
    
    if (!q) {
      this.filteredData = this.data.slice(0, this.maxResults);
    } else {
      this.filteredData = this.data.filter(item => {
        const titleMatch = (item.title || '').toLowerCase().includes(q);
        const subtitleMatch = (item.subtitle || '').toLowerCase().includes(q);
        const badgeMatch = (item.badge || '').toLowerCase().includes(q);
        return titleMatch || subtitleMatch || badgeMatch;
      }).slice(0, this.maxResults);
    }

    this.renderMenu();
  }

  renderMenu() {
    this.listEl.innerHTML = '';
    this.highlightIndex = -1;

    // Optional clear/unassigned entry at top if allowed
    if (this.allowClear) {
      const clearOption = document.createElement('div');
      clearOption.className = 'px-3 py-2 text-xs text-muted hover:text-foreground hover:bg-background/80 rounded-lg cursor-pointer flex items-center gap-2 transition-colors';
      clearOption.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-border"></span>
        <span>${this.clearLabel}</span>
      `;
      clearOption.addEventListener('click', () => {
        this.setValue('', true);
        this.close();
      });
      this.listEl.appendChild(clearOption);
    }

    if (this.filteredData.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-4 py-3 text-xs text-muted text-center';
      empty.textContent = this.emptyMessage;
      this.listEl.appendChild(empty);
      return;
    }

    this.filteredData.forEach((item, index) => {
      const el = document.createElement('div');
      const isSelected = String(item.id) === String(this.value);
      el.id = `${this.id}_opt_${index}`;
      el.className = `px-3 py-2 rounded-lg cursor-pointer flex items-center justify-between text-sm transition-colors ${
        isSelected ? 'bg-primary/10 text-primary font-medium' : 'text-foreground hover:bg-background/70'
      }`;

      // Create initials badge
      const initials = (item.title || 'U').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();

      el.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-7 h-7 rounded-lg bg-primary/20 text-primary flex items-center justify-center text-xs font-semibold flex-shrink-0">
            ${initials}
          </div>
          <div class="min-w-0">
            <p class="text-sm font-medium truncate">${this.escapeHtml(item.title)}</p>
            ${item.subtitle ? `<p class="text-xs text-muted truncate">${this.escapeHtml(item.subtitle)}</p>` : ''}
          </div>
        </div>
        ${item.badge ? `<span class="px-2 py-0.5 rounded text-[11px] bg-background border border-border text-muted font-mono flex-shrink-0 ml-2">${item.badge}</span>` : ''}
      `;

      el.addEventListener('click', () => {
        this.selectItem(item);
      });

      this.listEl.appendChild(el);
    });
  }

  highlight(index) {
    if (this.filteredData.length === 0) return;
    
    // Bounds check
    if (index < 0) index = this.filteredData.length - 1;
    if (index >= this.filteredData.length) index = 0;

    this.highlightIndex = index;

    // Remove previous highlights
    const items = this.listEl.querySelectorAll('[id^="' + this.id + '_opt_"]');
    items.forEach((el, idx) => {
      if (idx === index) {
        el.classList.add('bg-background', 'ring-1', 'ring-primary/50');
        el.scrollIntoView({ block: 'nearest' });
      } else {
        el.classList.remove('bg-background', 'ring-1', 'ring-primary/50');
      }
    });
  }

  selectItem(item) {
    this.setValue(item.id, true);
    this.close();
  }

  setValue(val, triggerChange = true) {
    this.value = val !== null && val !== undefined ? String(val) : '';
    this.hiddenEl.value = this.value;

    const matched = this.data.find(d => String(d.id) === String(this.value));

    if (matched) {
      this.inputEl.value = matched.title;
      this.clearBtn.classList.remove('hidden');
    } else {
      this.inputEl.value = '';
      this.clearBtn.classList.add('hidden');
    }

    if (triggerChange && typeof this.onChange === 'function') {
      this.onChange(this.value, matched);
    }
  }

  getValue() {
    return this.value;
  }

  updateDisplay() {
    this.setValue(this.value, false);
  }

  open() {
    this.isOpen = true;
    this.menuEl.classList.remove('hidden');
  }

  close() {
    this.isOpen = false;
    this.menuEl.classList.add('hidden');
    // Restore current selected item's title in the input
    const matched = this.data.find(d => String(d.id) === String(this.value));
    this.inputEl.value = matched ? matched.title : '';
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }
}

window.SearchableSelect = SearchableSelect;
