/**
 * Virtualized List for GoatCode TUI — renders only visible items.
 * Uses windowing to avoid rendering thousands of React nodes at once.
 */
import { Box, Static, Text } from "ink";
import { useState, useRef, useCallback, useMemo } from "react";

const DEFAULT_ITEM_HEIGHT = 2; // terminal rows per item
const BUFFER_ITEMS = 5; // extra items to render above/below viewport

export interface VirtualListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  getItemHeight?: (item: T, index: number) => number;
  containerHeight?: number;
  overscanCount?: number;
}

export function VirtualList<T>({
  items,
  renderItem,
  getItemHeight,
  containerHeight = 20,
  overscanCount = 2,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Calculate total height
  const totalHeight = useMemo(() => {
    if (!getItemHeight) return items.length * DEFAULT_ITEM_HEIGHT;
    return items.reduce((sum, item, i) => sum + getItemHeight(item, i), 0);
  }, [items, getItemHeight]);

  // Calculate visible range
  const { startIdx, endIdx } = useMemo(() => {
    const itemHeight = getItemHeight ?? ((_: T, i: number) => DEFAULT_ITEM_HEIGHT);
    let top = 0;
    let start = 0;
    for (let i = 0; i < items.length; i++) {
      const h = itemHeight(items[i], i);
      if (top + h > scrollTop - overscanCount * DEFAULT_ITEM_HEIGHT) {
        start = Math.max(0, i - overscanCount);
        break;
      }
      top += h;
    }
    let bottom = 0;
    let end = items.length - 1;
    for (let i = items.length - 1; i >= 0; i--) {
      const h = itemHeight(items[i], i);
      if (bottom + h > totalHeight - scrollTop - containerHeight + overscanCount * DEFAULT_ITEM_HEIGHT) {
        end = Math.min(items.length - 1, i + overscanCount);
        break;
      }
      bottom += h;
    }
    return { startIdx: start, endIdx: end };
  }, [items, scrollTop, totalHeight, containerHeight, overscanCount, getItemHeight]);

  // Render only visible items with padding
  const visibleItems = useMemo(() => {
    const itemHeight = getItemHeight ?? ((_: T, i: number) => DEFAULT_ITEM_HEIGHT);
    let offset = 0;
    for (let i = 0; i < startIdx; i++) {
      offset += itemHeight(items[i], i);
    }
    const result: { item: T; index: number; top: number; height: number }[] = [];
    for (let i = startIdx; i <= endIdx && i < items.length; i++) {
      const h = itemHeight(items[i], i);
      result.push({ item: items[i], index: i, top: offset, height: h });
      offset += h;
    }
    return result;
  }, [items, startIdx, endIdx, getItemHeight]);

  const handleScroll = useCallback((delta: number) => {
    setScrollTop((prev) => Math.max(0, Math.min(prev + delta, totalHeight - containerHeight)));
  }, [totalHeight, containerHeight]);

  return (
    <Box flexDirection="column" height={containerHeight} position="relative">
      <Box height={totalHeight} position="absolute" top={0} left={0} right={0}>
        {visibleItems.map(({ item, index, top, height }) => (
          <Box key={`${index}-${item}`} position="absolute" top={top} left={0} right={0} height={height}>
            {renderItem(item, index)}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/**
 * Simple scrollable list for TUI — renders last N items by default.
 */
export function ScrollableList<T>({
  items,
  renderItem,
  maxVisible = 10,
}: {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  maxVisible?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const displayItems = showAll ? items : items.slice(-maxVisible);

  return (
    <Box flexDirection="column">
      <Static items={displayItems}>
        {(item, idx) => (
          <Box key={`${idx}-${String(item)}`}>
            {renderItem(item, idx)}
          </Box>
        )}
      </Static>
      {items.length > maxVisible && (
        <Box onClick={() => setShowAll(!showAll)} cursor="pointer">
          <Text color="#a855f7">
            {showAll ? "Show less ▲" : `Show ${items.length - maxVisible} more ▼`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
