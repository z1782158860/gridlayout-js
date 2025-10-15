class GridLayout {
    constructor(containerSelector) {
        this.container = document.querySelector(containerSelector);
        this.items = [];
        this.currentId = 1;
        this.prevGridWidth = 0;
        this.widgetComponents = new Map(); 
        this.exposedGlobals = {}; 
        this.widgetExposedGlobals = new Map();

        this.longPressTimer = null;
        this.longPressDelay = 400; 
        this.isLongPress = false;
        this.isDragging = false; 

        this.sizes = [
            { cols: 1, rows: 1 },
            { cols: 2, rows: 1 },
            { cols: 2, rows: 2 },
            { cols: 4, rows: 2 }
        ];

        this.touchItem = null;
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.lastTouchMoveTime = 0;

        this.injectStyles();
    }

    setExposedGlobals(globals) {
        if (globals && typeof globals === 'object') {
            this.exposedGlobals = globals;
        }
    }

    init() {
        this.container.classList.add('gl-grid-container');
        this.setupEventListeners();
        this.setupResizeObserver();
    }

    addItem(size, widgetData = null, widgetGlobals = null, position = null) {
        const id = this.currentId++;
        const pos = position !== null ? position : this.findPosition(size);
        const item = { id, size, position: pos, widgetData };

        const element = this.createGridItem(id, widgetData);
        this.container.appendChild(element);
        this.items.push(item);
        this.updateLayout();

        if (widgetGlobals && typeof widgetGlobals === 'object') {
            this.widgetExposedGlobals.set(id, widgetGlobals);
        }

        if (widgetData) {
            this.initializeWidget(id, widgetData);
        }

        return id;
    }

    removeItem(itemId) {
        const index = this.items.findIndex(item => item.id === itemId);
        if (index === -1) return;

        this.destroyWidget(itemId);
        
        this.widgetExposedGlobals.delete(itemId);

        const itemElement = this.container.querySelector(`[data-gl-id="${itemId}"]`);
        if (itemElement) {
            itemElement.remove();
        }

        this.items.splice(index, 1);

        this.updateLayout();
    }

    getLayoutJson() {
        const layoutData = {
            exposedGlobals: this.exposedGlobals,
            widgets: this.items.map(item => ({
                size: { cols: item.size.cols, rows: item.size.rows },
                widgetData: item.widgetData,
                widgetGlobals: this.widgetExposedGlobals.get(item.id) || {},
                position: item.position
            }))
        };
        return JSON.stringify(layoutData, null, 2);
    }

    importLayout(json) {
        try {
            const data = JSON.parse(json);
            if (typeof data !== 'object' || !Array.isArray(data.widgets)) {
                throw new Error('Invalid JSON format');
            }

            this.items = [];
            this.container.innerHTML = '';
            this.widgetComponents.clear();
            this.widgetExposedGlobals.clear();
            this.currentId = 1;

            if (data.exposedGlobals && typeof data.exposedGlobals === 'object') {
                this.exposedGlobals = data.exposedGlobals;
            }

            data.widgets.forEach(widget => {
                this.addItem(
                    widget.size,
                    widget.widgetData,
                    widget.widgetGlobals,
                    widget.position
                );
            });

            this.updateLayout();
            return true;
        } catch (e) {
            console.error(`Import failed: ${e.message}`);
            return false;
        }
    }

    reset() {

        const itemsBackup = this.items.map(item => ({
            size: item.size,
            widgetData: item.widgetData,
            position: item.position,
            widgetGlobals: this.widgetExposedGlobals.get(item.id) || {}
        }));

        this.items = [];
        this.container.innerHTML = '';
        this.widgetComponents.clear();
        this.widgetExposedGlobals.clear();
        this.currentId = 1;

        itemsBackup.forEach(item => {
            this.addItem(
                item.size,
                item.widgetData,
                item.widgetGlobals,
                item.position
            );
        });
    }

    initializeWidget(itemId, widgetData) {
        this.destroyWidget(itemId);

        const widgetContainer = this.container.querySelector(`[data-gl-id="${itemId}"] .gl-widget-container`);
        if (!widgetContainer) return;

        try {

            widgetContainer.style.touchAction = 'auto';

            let styleElement = null;
            if (widgetData.css && widgetData.css.trim() !== '') {
                styleElement = document.createElement('style');
                styleElement.dataset.glStyleFor = itemId;
                styleElement.textContent = this.scopeCSS(widgetData.css, `[data-gl-id="${itemId}"]`);
                document.head.appendChild(styleElement);
            }

            let widgetInstance = null;
            if (widgetData.js && widgetData.js.trim() !== '') {
                widgetInstance = this.executeScopedJS(widgetData.js, widgetContainer, itemId);
            }

            this.widgetComponents.set(itemId, {
                instance: widgetInstance,
                styleElement: styleElement
            });
        } catch (e) {
            console.error(`Error initializing widget ${itemId}:`, e);
        }
    }

    destroyWidget(itemId) {
        if (!this.widgetComponents.has(itemId)) return;

        const widget = this.widgetComponents.get(itemId);

        if (widget.instance && typeof widget.instance.destroy === 'function') {
            widget.instance.destroy();
        }

        if (widget.styleElement && widget.styleElement.parentNode) {
            widget.styleElement.parentNode.removeChild(widget.styleElement);
        }

        this.widgetComponents.delete(itemId);
    }

    scopeCSS(css, scopeSelector) {
        if (!css) return '';

        return css
            .split('}')
            .filter(rule => rule.trim())
            .map(rule => {
                const [selectors, styles] = rule.split('{');
                if (!selectors || !styles) return rule;

                const scopedSelectors = selectors
                    .split(',')
                    .map(selector => {
                        const trimmed = selector.trim();
                        if (trimmed.startsWith('@')) return trimmed;
                        return `${scopeSelector} ${trimmed}`;
                    })
                    .join(', ');

                return `${scopedSelectors} { ${styles} }`;
            })
            .join(' ');
    }

    executeScopedJS(jsCode, container, itemId) {
        if (!jsCode) return null;

        try {
            const mergedGlobals = {
                ...this.exposedGlobals,
                ...(this.widgetExposedGlobals.get(itemId) || {})
            };
            
            const context = {
                container,
                itemId,
                document: container.ownerDocument,
                window: container.ownerDocument.defaultView,
                GridLayout: {
                    globals: mergedGlobals
                }
            };

            const widgetFunction = new Function(
                'container', 'itemId', 'GridLayout',
                `return (function() {
                    ${jsCode}
                }).call(this);`
            );

            return widgetFunction.call(context, container, itemId, context.GridLayout);
        } catch (e) {
            console.error(`Error executing widget JS for item ${itemId}:`, e);
            return null;
        }
    }

    createGridItem(id, widgetData = null) {
        const item = document.createElement('div');
        item.className = 'gl-grid-item';
        item.dataset.glId = id;

        const widgetContainer = document.createElement('div');
        widgetContainer.className = 'gl-widget-container';

        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'gl-widget-loading';
        loadingIndicator.textContent = 'Loading...';
        widgetContainer.appendChild(loadingIndicator);

        const widgetText = document.createElement('div');
        widgetText.className = 'gl-widget-text';
        widgetText.draggable = true;

        item.appendChild(widgetContainer);
        item.appendChild(widgetText);

        if (widgetData && widgetData.html) {
            widgetContainer.innerHTML = widgetData.html;
        }
        if (widgetData && widgetData.text) {
            widgetText.innerHTML = widgetData.text;
        }

        widgetText.addEventListener('dragstart', this.handleDragStart.bind(this));
        widgetText.addEventListener('dragend', this.handleDragEnd.bind(this));

        item.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: true });
        item.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
        item.addEventListener('touchend', this.handleTouchEnd.bind(this));
        item.addEventListener('touchcancel', this.handleTouchEnd.bind(this));

        const loadResources = async () => {
            try {
                let htmlContent = '';
                if (widgetData?.htmlUrl) {
                    htmlContent = await this.loadResource(widgetData.htmlUrl);
                } else if (widgetData?.html) {
                    htmlContent = widgetData.html;
                }

                let cssContent = '';
                if (widgetData?.cssUrl) {
                    cssContent = await this.loadResource(widgetData.cssUrl);
                } else if (widgetData?.css) {
                    cssContent = widgetData.css;
                }

                let jsContent = '';
                if (widgetData?.jsUrl) {
                    jsContent = await this.loadResource(widgetData.jsUrl);
                } else if (widgetData?.js) {
                    jsContent = widgetData.js;
                }

                widgetContainer.innerHTML = htmlContent || '';
                if (widgetData?.text) {
                    widgetText.innerHTML = widgetData.text;
                }

                const scripts = widgetContainer.querySelectorAll('script');
                scripts.forEach(script => {
                    const newScript = document.createElement('script');
                    if (script.src) {
                        newScript.src = script.src;
                    } else {
                        newScript.textContent = script.textContent;
                    }
                    widgetContainer.appendChild(newScript);
                });

                if (jsContent) {
                    this.initializeWidget(id, { 
                        ...widgetData, 
                        html: htmlContent, 
                        css: cssContent, 
                        js: jsContent 
                    });
                }

                loadingIndicator.remove();
            } catch (error) {
                console.error(`Failed to load resources for widget ${id}:`, error);
                loadingIndicator.textContent = 'Load Failed';
                loadingIndicator.classList.add('gl-widget-error');
            }
        };

        loadResources();

        return item;
    }

    findPosition(size, startY = 0) {
        const rootStyles = getComputedStyle(this.container);
        const cellSize = parseFloat(rootStyles.getPropertyValue('--gl-cell-size')) || 100;
        const gap = parseFloat(rootStyles.getPropertyValue('--gl-gap')) || 20;
        const gridWidth = Math.floor(this.container.clientWidth / (cellSize + gap));
        const grid = Array(gridWidth).fill().map(() => []);

        this.items.forEach(item => {
            for (let y = item.position.y; y < item.position.y + item.size.rows; y++) {
                if (!grid[y]) grid[y] = [];
                for (let x = item.position.x; x < item.position.x + item.size.cols; x++) {
                    grid[y][x] = item.id;
                }
            }
        });

        for (let y = startY; y <= (grid.length || 0); y++) {
            for (let x = 0; x < gridWidth; x++) {
                if (x + size.cols > gridWidth) continue;

                let canPlace = true;
                for (let dy = 0; dy < size.rows; dy++) {
                    const currentY = y + dy;
                    if (!grid[currentY]) grid[currentY] = [];

                    for (let dx = 0; dx < size.cols; dx++) {
                        const currentX = x + dx;
                        if (currentX >= gridWidth || grid[currentY][currentX] !== undefined) {
                            canPlace = false;
                            break;
                        }
                    }
                    if (!canPlace) break;
                }

                if (canPlace) return { x, y };
            }
        }

        for (let y = 0; y < startY; y++) {
            for (let x = 0; x < gridWidth; x++) {
                if (x + size.cols > gridWidth) continue;

                let canPlace = true;
                for (let dy = 0; dy < size.rows; dy++) {
                    const currentY = y + dy;
                    if (!grid[currentY]) grid[currentY] = [];

                    for (let dx = 0; dx < size.cols; dx++) {
                        const currentX = x + dx;
                        if (currentX >= gridWidth || grid[currentY][currentX] !== undefined) {
                            canPlace = false;
                            break;
                        }
                    }
                    if (!canPlace) break;
                }

                if (canPlace) return { x, y };
            }
        }

        return { x: 0, y: grid.length };
    }

    updateLayout() {
        this.items.forEach(item => {
            const element = this.container.querySelector(`[data-gl-id="${item.id}"]`);
            if (element) {
                element.style.gridColumn = `${item.position.x + 1} / span ${item.size.cols}`;
                element.style.gridRow = `${item.position.y + 1} / span ${item.size.rows}`;
            }
        });
    }

    handleDragStart(e) {
        if (e.target.closest('.gl-no-drag')) return;
        
        const gridItem = e.target.closest('.gl-grid-item');
        if (!gridItem) return;
        
        this.draggedItem = gridItem;
        this.draggedItem.classList.add('gl-dragging');
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        e.dataTransfer.setData('text/plain', gridItem.dataset.glId);
    }

    handleDragEnd() {
        if (this.draggedItem) {
            this.draggedItem.classList.remove('gl-dragging');
            this.draggedItem = null;
        }
    }

    handleTouchStart(e) {
        if (e.target.closest('.gl-no-drag') || this.isDragging) return;

        const targetItem = e.target.closest('.gl-grid-item');
        if (!targetItem) return;

        const touch = e.touches[0];
        this.touchStartX = touch.clientX;
        this.touchStartY = touch.clientY;
        this.isLongPress = false;
        this.isDragging = false;

        this.longPressTimer = setTimeout(() => {
            this.isLongPress = true;
            this.isDragging = true;

            this.touchItem = targetItem;
            this.touchItem.classList.add('gl-dragging');
            this.touchItem.style.zIndex = '100';

            this.touchItem.style.boxShadow = '0 0 10px rgba(0,0,0,0.3)';

        }, this.longPressDelay);
    }

    handleTouchMove(e) {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        const now = Date.now();
        if (now - this.lastTouchMoveTime < 16) return;
        this.lastTouchMoveTime = now;

        const touch = e.touches[0];
        const dx = touch.clientX - this.touchStartX;
        const dy = touch.clientY - this.touchStartY;

        const moveDistance = Math.sqrt(dx * dx + dy * dy);
        if (moveDistance < 5) return;

        if (this.touchItem && this.isLongPress) {
            this.touchItem.style.transform = `translate(${dx}px, ${dy}px)`;
            e.preventDefault();
        }
    }

    handleTouchEnd(e) {
    
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        if (this.touchItem && this.isLongPress) {
            this.touchItem.classList.remove('gl-dragging');
            this.touchItem.style.transform = '';
            this.touchItem.style.boxShadow = '';
            this.touchItem.style.zIndex = '';

            const rect = this.container.getBoundingClientRect();
            const itemRect = this.touchItem.getBoundingClientRect();
            const rootStyles = getComputedStyle(this.container);
            const cellSize = parseFloat(rootStyles.getPropertyValue('--gl-cell-size')) || 100;
            const gap = parseFloat(rootStyles.getPropertyValue('--gl-gap')) || 20;

            const x = Math.round((itemRect.left - rect.left) / (cellSize + gap));
            const y = Math.round((itemRect.top - rect.top) / (cellSize + gap));
            const itemId = parseInt(this.touchItem.dataset.glId);

            this.updateItemPosition(itemId, x, y);

            setTimeout(() => {
                this.updateLayout();
                this.container.classList.remove('gl-dragging-active');
            }, 100);
        }

        this.touchItem = null;
        this.isLongPress = false;
        this.isDragging = false;
        this.container.classList.remove('gl-dragging-active');
    }

    updateItemPosition(itemId, x, y) {
        const item = this.items.find(item => item.id === itemId);
        if (!item) return;

        const { cols, rows } = item.size;
        const rootStyles = getComputedStyle(this.container);
        const cellSize = parseFloat(rootStyles.getPropertyValue('--gl-cell-size')) || 100;
        const gap = parseFloat(rootStyles.getPropertyValue('--gl-gap')) || 20;
        const gridWidth = Math.floor(this.container.clientWidth / (cellSize + gap));

        if (x < 0 || y < 0 || x + cols > gridWidth) return;

        let canPlace = true;
        for (let dy = 0; dy < rows; dy++) {
            for (let dx = 0; dx < cols; dx++) {
                const checkX = x + dx;
                const checkY = y + dy;

                const occupied = this.items.some(otherItem => {
                    if (otherItem.id === itemId) return false;
                    const [oX, oY] = [otherItem.position.x, otherItem.position.y];
                    return (checkX >= oX && checkX < oX + otherItem.size.cols) &&
                        (checkY >= oY && checkY < oY + otherItem.size.rows);
                });

                if (occupied) {
                    canPlace = false;
                    break;
                }
            }
            if (!canPlace) break;
        }

        if (canPlace) {
            item.position = { x, y };
            this.updateLayout();
        } else {
            item.position = { x, y };
            const conflictingItems = this.items.filter(otherItem => {
                if (otherItem.id === itemId) return false;
                return this.checkItemsOverlap(item, otherItem);
            });

            conflictingItems.forEach(conflict => {
                conflict.position = this.findPosition(conflict.size, Math.max(0, conflict.position.y - 2));
            });

            this.updateLayout();
        }
    }

    checkItemsOverlap(itemA, itemB) {
        const [aX, aY] = [itemA.position.x, itemA.position.y];
        const [bX, bY] = [itemB.position.x, itemB.position.y];

        return aX < bX + itemB.size.cols &&
            aX + itemA.size.cols > bX &&
            aY < bY + itemB.size.rows &&
            aY + itemA.size.rows > bY;
    }

    setupEventListeners() {
        this.container.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!this.draggedItem) return;

            const dx = e.clientX - this.dragStartX;
            const dy = e.clientY - this.dragStartY;
            this.draggedItem.style.transform = `translate(${dx}px, ${dy}px)`;
        });

        this.container.addEventListener('drop', (e) => {
            e.preventDefault();
            if (!this.draggedItem) return;

            this.draggedItem.style.transform = '';
            const rect = this.container.getBoundingClientRect();
            const itemRect = this.draggedItem.getBoundingClientRect();
            const rootStyles = getComputedStyle(this.container);
            const cellSize = parseFloat(rootStyles.getPropertyValue('--gl-cell-size')) || 100;
            const gap = parseFloat(rootStyles.getPropertyValue('--gl-gap')) || 20;

            const x = Math.round((itemRect.left - rect.left) / (cellSize + gap));
            const y = Math.round((itemRect.top - rect.top) / (cellSize + gap));
            const itemId = parseInt(this.draggedItem.dataset.glId);

            this.updateItemPosition(itemId, x, y);
        });
    }

    setupResizeObserver() {
        const resizeObserver = new ResizeObserver(entries => {
            const entry = entries[0];
            if (!entry) return;

            const rootStyles = getComputedStyle(this.container);
            const cellSize = parseFloat(rootStyles.getPropertyValue('--gl-cell-size')) || 100;
            const gap = parseFloat(rootStyles.getPropertyValue('--gl-gap')) || 20;
            const newGridWidth = Math.floor(entry.contentRect.width / (cellSize + gap));

            this.items.forEach(item => {
                const currentRight = item.position.x + item.size.cols;
                if (currentRight > newGridWidth) {
                    item.position = this.findPosition(item.size, 0);
                }
            });

            this.updateLayout();
            this.prevGridWidth = newGridWidth;
        });

        resizeObserver.observe(this.container);
    }

    async loadResource(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to load resource: ${response.status}`);
            return await response.text();
        } catch (error) {
            console.error('Resource load error:', error);
            return null;
        }
    }

    injectStyles() {
        const styleId = 'gl-styles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            :root {
                --gl-gap: 0px;
                --gl-cell-size: 100px;
            }
            
            .gl-grid-container {
                display: grid;
                grid-template-columns: repeat(auto-fill, var(--gl-cell-size));
                grid-auto-rows: var(--gl-cell-size);
                gap: var(--gl-gap);
                width: 100%;
                min-height: 200px;
                padding: 10px;
                padding-bottom: 30px;
            }
            
            .gl-grid-item {
                color: #333;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: start;
                font-weight: bold;
                box-sizing: border-box;
                position: relative;
                transition: transform 0.1s;
            }
            
            .gl-grid-item .gl-widget-container {
                /*background-color: rgba(255,255,255,.3);*/
                box-shadow: 0 1px 5px rgba(0,0,0,.1);
                border-radius: 10px;
                width: calc(100% - 25px);
                height: calc(100% - 25px);
                padding: 0;
                margin: 0;
                box-sizing: border-box;
                overflow: auto;
                scrollbar-width: none;
            }
            .gl-widget-text{
                width: 100%;
                height: 20px;
                margin-top: 3px;
                line-height: 20px;
                font-size: .8rem;
                text-align: center;
                color: #666;
                cursor: move;
            }

            .gl-grid-item.gl-dragging {
                opacity: 0.8;
                transform: scale(1.05);
                z-index: 10;
            }
            
            .gl-no-drag {
                cursor: default;
            }
            
            
            @media (max-width: 768px) {
                :root {
                    --gl-cell-size: 80px;
                    --gl-gap: 0px;
                }
                .gl-widget-container {
                    -webkit-overflow-scrolling: touch !important;
                    overflow: auto !important;
                }
                
                .gl-dragging-active .gl-widget-container {
                    overflow: hidden !important;
                }
                
                .gl-grid-item:active {
                    transform: scale(0.98);
                }
            }

            .gl-widget-loading {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.8);
                color: #666;
                font-size: 14px;
                z-index: 10;
            }
            
            .gl-widget-error {
                color: #ff4d4f;
            }
        `;

        document.head.appendChild(style);
    }
}