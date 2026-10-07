import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

type SwipePagerProps = {
  /** 页码从 1 开始。 */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  renderPage: (page: number) => ReactNode;
};

type PagerSlotProps = {
  pageNumber: number;
  pageWidth: SharedValue<number>;
  positionPage: SharedValue<number>;
  active: boolean;
  children: ReactNode;
};

const MIN_SWIPE_DISTANCE = 56;
const SWIPE_DISTANCE_RATIO = 0.2;
const FLING_VELOCITY = 900;
const TRANSITION_DURATION = 240;
const PAGE_BUFFER = 2;

function clampPage(page: number, pageCount: number) {
  return Math.min(Math.max(page, 1), pageCount);
}

function PagerSlot({
  pageNumber,
  pageWidth,
  positionPage,
  active,
  children,
}: PagerSlotProps) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: (pageNumber - positionPage.value) * pageWidth.value },
    ],
    // 页面过半后让目标页位于上层，避免 React 页码同步前露出旧页内容。
    zIndex: Math.round(positionPage.value) === pageNumber ? 2 : 1,
  }));

  return (
    <Animated.View
      pointerEvents={active ? "auto" : "none"}
      style={[
        styles.page,
        active ? styles.currentPage : styles.adjacentPage,
        animatedStyle,
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * 横向平铺翻页容器：把每次滑动记录成方向意图，再按队列逐页平滑执行。
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

  // positionPage 是连续页坐标，整数表示停靠页，动画期间允许处于两页之间。
  const positionPage = useSharedValue(normalizedPage);
  const gestureStartPosition = useSharedValue(normalizedPage);
  const currentPage = useSharedValue(normalizedPage);
  const pageWidth = useSharedValue(Math.max(1, width));
  const pageCountSV = useSharedValue(safePageCount);
  const swipeQueue = useSharedValue<number[]>([]);
  const isTransitioning = useSharedValue(false);
  const isReturning = useSharedValue(false);
  const pagePropRef = useRef(normalizedPage);
  const internalPageTargetsRef = useRef(new Set<number>());
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
    const propChanged = nextPage !== pagePropRef.current;
    const isInternalTarget = internalPageTargetsRef.current.has(nextPage);
    pagePropRef.current = nextPage;

    if (isInternalTarget) {
      // 父组件正在回传队列刚提交的页码，不能把正在执行的队列清掉。
      internalPageTargetsRef.current.delete(nextPage);
      if (nextPage === visiblePage) currentPage.value = nextPage;
      return;
    }

    // 内部队列已切到新页，但父组件的受控页码还在下一次 render 才更新。
    if (!propChanged && nextPage !== visiblePage) return;

    if (nextPage === visiblePage) {
      if (propChanged) {
        cancelAnimation(positionPage);
        positionPage.value = nextPage;
        gestureStartPosition.value = nextPage;
        swipeQueue.value = [];
        isTransitioning.value = false;
        isReturning.value = false;
        internalPageTargetsRef.current.clear();
      }
      currentPage.value = nextPage;
      return;
    }

    internalPageTargetsRef.current.clear();

    // 外部分组、搜索或页码变化时，清空队列并直接定位目标页。
    cancelAnimation(positionPage);
    positionPage.value = nextPage;
    gestureStartPosition.value = nextPage;
    currentPage.value = nextPage;
    swipeQueue.value = [];
    isTransitioning.value = false;
    isReturning.value = false;
    setVisiblePage(nextPage);
  }, [
    currentPage,
    gestureStartPosition,
    isReturning,
    isTransitioning,
    page,
    pageCountSV,
    positionPage,
    safePageCount,
    swipeQueue,
    visiblePage,
  ]);

  const announcePage = (nextPage: number) => {
    internalPageTargetsRef.current.add(nextPage);
    setVisiblePage(nextPage);
    onPageChangeRef.current(nextPage);
  };

  // 队列变化或上一页动画结束后，由 reaction 取出下一条意图，避免 worklet 自引用。
  useAnimatedReaction(
    () => swipeQueue.value.length > 0 && !isTransitioning.value,
    (shouldStart) => {
      if (!shouldStart) return;

      const queue = swipeQueue.value.slice();
      while (queue.length > 0) {
        const direction = queue.shift() ?? 0;
        const targetPage = currentPage.value + direction;
        if (targetPage < 1 || targetPage > pageCountSV.value) continue;

        swipeQueue.value = queue;
        currentPage.value = targetPage;
        isTransitioning.value = true;
        isReturning.value = false;
        runOnJS(announcePage)(targetPage);

        const distance = Math.max(
          0.5,
          Math.abs(targetPage - positionPage.value),
        );
        const duration = Math.max(
          140,
          Math.min(
            TRANSITION_DURATION,
            Math.round(TRANSITION_DURATION * distance),
          ),
        );
        positionPage.value = withTiming(
          targetPage,
          { duration },
          (finished) => {
            if (!finished) return;
            positionPage.value = targetPage;
            isTransitioning.value = false;
          },
        );
        return;
      }

      swipeQueue.value = queue;
    },
  );
  const enqueueDirection = (direction: number) => {
    "worklet";
    if (direction === 0) return;

    // 按“当前动画目标 + 已排队意图”计算虚拟页，提前丢弃越界操作。
    let plannedPage = currentPage.value;
    for (const queuedDirection of swipeQueue.value) {
      plannedPage += queuedDirection;
    }
    const queuedTarget = plannedPage + direction;
    if (queuedTarget < 1 || queuedTarget > pageCountSV.value) return;

    swipeQueue.value = [...swipeQueue.value, direction];
  };

  const returnToCurrentPage = () => {
    "worklet";
    isReturning.value = true;
    positionPage.value = withSpring(
      currentPage.value,
      {
        damping: 24,
        stiffness: 260,
        mass: 0.85,
      },
      (finished) => {
        if (finished) isReturning.value = false;
      },
    );
  };

  const panGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-12, 12])
    .onStart(() => {
      // 动画进行中只记录意图，不打断当前轨道；空闲时才让手指直接控制轨道。
      if (isTransitioning.value) return;
      cancelAnimation(positionPage);
      isReturning.value = false;
      gestureStartPosition.value = positionPage.value;
    })
    .onUpdate((event) => {
      if (isTransitioning.value) return;

      const current = currentPage.value;
      const width = pageWidth.value;
      const rawPosition =
        gestureStartPosition.value - event.translationX / width;
      const minPosition = Math.max(1, current - 1);
      const maxPosition = Math.min(pageCountSV.value, current + 1);
      let nextPosition = Math.max(
        minPosition,
        Math.min(maxPosition, rawPosition),
      );

      if (current === 1 && rawPosition < 1) {
        nextPosition = 1 + (rawPosition - 1) * 0.24;
      } else if (
        current === pageCountSV.value &&
        rawPosition > pageCountSV.value
      ) {
        nextPosition =
          pageCountSV.value +
          (rawPosition - pageCountSV.value) * 0.24;
      }

      positionPage.value = nextPosition;
    })
    .onEnd((event) => {
      "worklet";
      const width = pageWidth.value;
      const threshold = Math.max(
        MIN_SWIPE_DISTANCE,
        width * SWIPE_DISTANCE_RATIO,
      );
      const hasDistance = Math.abs(event.translationX) > threshold;
      const hasFling = Math.abs(event.velocityX) > FLING_VELOCITY;
      const direction =
        event.translationX > 0
          ? -1
          : event.translationX < 0
            ? 1
            : event.velocityX > 0
              ? -1
              : event.velocityX < 0
                ? 1
                : 0;

      if (!hasDistance && !hasFling) {
        if (!isTransitioning.value) returnToCurrentPage();
        return;
      }

      if (isTransitioning.value) {
        // 快速连续滑动只入队，当前动画保持匀速完成。
        enqueueDirection(direction);
        return;
      }

      enqueueDirection(direction);
    })
    .onFinalize(() => {
      if (isTransitioning.value || isReturning.value) return;
      returnToCurrentPage();
    });

  const firstPage = Math.max(1, visiblePage - PAGE_BUFFER);
  const lastPage = Math.min(safePageCount, visiblePage + PAGE_BUFFER);
  const pages = [];
  for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
    pages.push(pageNumber);
  }

  return (
    <GestureDetector gesture={panGesture}>
      <View style={styles.viewport}>
        {pages.map((pageNumber) => (
          <PagerSlot
            key={`page-${pageNumber}`}
            pageNumber={pageNumber}
            pageWidth={pageWidth}
            positionPage={positionPage}
            active={pageNumber === visiblePage}
          >
            {renderPage(pageNumber)}
          </PagerSlot>
        ))}
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
