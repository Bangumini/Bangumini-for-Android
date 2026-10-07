import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

type SwipePagerProps = {
  /** 页码从 1 开始。 */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  renderPage: (page: number) => ReactNode;
};

const MIN_SWIPE_DISTANCE = 56;
const SWIPE_DISTANCE_RATIO = 0.2;
const FLING_VELOCITY = 900;
const TRANSITION_DURATION = 240;

function clampPage(page: number, pageCount: number) {
  return Math.min(Math.max(page, 1), pageCount);
}

/**
 * 横向平铺翻页容器：拖动时同时移动当前页和相邻页，避免切换数据后再淡入造成断层。
 */
export function SwipePager({
  page,
  pageCount,
  onPageChange,
  renderPage,
}: SwipePagerProps) {
  const { width } = useWindowDimensions();
  const safePageCount = Math.max(1, pageCount);
  const normalizedPage = clampPage(page, safePageCount);
  const [visiblePage, setVisiblePage] = useState(normalizedPage);

  const translateX = useSharedValue(0);
  const pageWidth = useSharedValue(Math.max(1, width));
  const visiblePageSV = useSharedValue(normalizedPage);
  const pageCountSV = useSharedValue(safePageCount);
  const isAnimating = useSharedValue(false);
  const onPageChangeRef = useRef(onPageChange);

  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  }, [onPageChange]);

  useEffect(() => {
    pageWidth.value = Math.max(1, width);
  }, [pageWidth, width]);

  useEffect(() => {
    pageCountSV.value = safePageCount;
    const nextPage = clampPage(page, safePageCount);
    visiblePageSV.value = nextPage;

    if (nextPage === visiblePage) return;

    // 外部切换分组或搜索条件时，立即回到新页，不沿用上一次的拖动位置。
    cancelAnimation(translateX);
    translateX.value = 0;
    isAnimating.value = false;
    setVisiblePage(nextPage);
  }, [
    isAnimating,
    page,
    pageCountSV,
    safePageCount,
    translateX,
    visiblePage,
    visiblePageSV,
  ]);

  const finishPageChange = (nextPage: number) => {
    translateX.value = 0;
    isAnimating.value = false;
    visiblePageSV.value = nextPage;
    setVisiblePage(nextPage);
    onPageChangeRef.current(nextPage);
  };

  const panGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-12, 12])
    .onUpdate((event) => {
      if (isAnimating.value) return;

      const currentPage = visiblePageSV.value;
      const width = pageWidth.value;
      const boundedTranslation = Math.max(
        -width,
        Math.min(width, event.translationX),
      );
      const atBoundary =
        (currentPage === 1 && boundedTranslation > 0) ||
        (currentPage === pageCountSV.value && boundedTranslation < 0);

      // 到达边界时保留一点阻尼，让用户知道这里没有下一页。
      translateX.value = atBoundary
        ? boundedTranslation * 0.24
        : boundedTranslation;
    })
    .onEnd((event) => {
      "worklet";
      if (isAnimating.value) return;

      const currentPage = visiblePageSV.value;
      const width = pageWidth.value;
      const distanceThreshold = Math.max(
        MIN_SWIPE_DISTANCE,
        width * SWIPE_DISTANCE_RATIO,
      );
      const shouldGoPrev =
        event.translationX > 0 &&
        currentPage > 1 &&
        (event.translationX > distanceThreshold || event.velocityX > FLING_VELOCITY);
      const shouldGoNext =
        event.translationX < 0 &&
        currentPage < pageCountSV.value &&
        (event.translationX < -distanceThreshold || event.velocityX < -FLING_VELOCITY);

      if (!shouldGoPrev && !shouldGoNext) {
        translateX.value = withSpring(0, {
          damping: 24,
          stiffness: 260,
          mass: 0.85,
        });
        return;
      }

      const direction = shouldGoPrev ? 1 : -1;
      const targetPage = shouldGoPrev ? currentPage - 1 : currentPage + 1;
      isAnimating.value = true;
      translateX.value = withTiming(
        direction * width,
        { duration: TRANSITION_DURATION },
        (finished) => {
          if (finished) runOnJS(finishPageChange)(targetPage);
        },
      );
    })
    .onFinalize(() => {
      if (isAnimating.value) return;
      translateX.value = withSpring(0, {
        damping: 24,
        stiffness: 260,
        mass: 0.85,
      });
    });

  const previousPageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -pageWidth.value + translateX.value }],
  }));
  const currentPageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const nextPageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pageWidth.value + translateX.value }],
  }));

  return (
    <GestureDetector gesture={panGesture}>
      <View style={styles.viewport}>
        {visiblePage > 1 ? (
          <Animated.View
            key={`page-${visiblePage - 1}`}
            pointerEvents="none"
            style={[styles.page, styles.adjacentPage, previousPageStyle]}
          >
            {renderPage(visiblePage - 1)}
          </Animated.View>
        ) : null}

        <Animated.View
          key={`page-${visiblePage}`}
          style={[styles.page, styles.currentPage, currentPageStyle]}
        >
          {renderPage(visiblePage)}
        </Animated.View>

        {visiblePage < safePageCount ? (
          <Animated.View
            key={`page-${visiblePage + 1}`}
            pointerEvents="none"
            style={[styles.page, styles.adjacentPage, nextPageStyle]}
          >
            {renderPage(visiblePage + 1)}
          </Animated.View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  viewport: {
    flex: 1,
    overflow: "hidden",
  },
  page: {
    ...StyleSheet.absoluteFillObject,
    flex: 1,
  },
  adjacentPage: {
    zIndex: 1,
  },
  currentPage: {
    zIndex: 2,
  },
});
