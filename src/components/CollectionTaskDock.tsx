import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
	getCollectionTaskQueue,
	getCollectionTaskSummary,
	ignoreCollectionTask,
	retryCollectionTask,
	subscribeCollectionTaskQueue,
	type CollectionTask,
} from "../api/collection-tasks";
import { useAuth } from "../hooks/useAuth";
import { colors } from "../theme/colors";

const TAB_BAR_CLEARANCE = 64;

const CollectionTaskQueueContext = createContext<CollectionTask[] | null>(null);

export function CollectionTaskQueueProvider({ children }: { children: ReactNode }) {
	const [tasks, setTasks] = useState<CollectionTask[]>([]);

	useEffect(() => {
		let cancelled = false;
		const syncTasks = () => {
			void getCollectionTaskQueue()
				.then((nextTasks) => {
					if (!cancelled) setTasks(nextTasks);
				})
				.catch((error) => {
					console.warn("[collection-task-dock] failed to read task queue", error);
				});
		};

		syncTasks();
		const unsubscribe = subscribeCollectionTaskQueue(syncTasks);
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	return (
		<CollectionTaskQueueContext.Provider value={tasks}>
			{children}
		</CollectionTaskQueueContext.Provider>
	);
}

export function useCollectionTaskQueue() {
	const tasks = useContext(CollectionTaskQueueContext);
	if (!tasks) {
		throw new Error("useCollectionTaskQueue must be used within CollectionTaskQueueProvider");
	}
	return tasks;
}

function getTaskStatusLabel(task: CollectionTask) {
	if (task.status === "failed") return "同步失败";
	if (task.status === "running") return "同步中";
	return "等待同步";
}

function getTaskPriority(task: CollectionTask) {
	if (task.status === "failed") return 0;
	if (task.status === "running") return 1;
	return 2;
}

export function CollectionTaskDock() {
	const { loggedIn, username } = useAuth();
	const insets = useSafeAreaInsets();
	const tasks = useCollectionTaskQueue();
	const [expanded, setExpanded] = useState(false);

	const visibleTasks = useMemo(() => {
		const scopedTasks = username
			? tasks.filter((task) => task.payload.username === username)
			: tasks;
		return scopedTasks
			.slice()
			.sort(
				(a, b) =>
					getTaskPriority(a) - getTaskPriority(b) || a.createdAt - b.createdAt,
			);
	}, [tasks, username]);

	useEffect(() => {
		if (visibleTasks.length === 0) setExpanded(false);
	}, [visibleTasks.length]);

	if (!loggedIn || visibleTasks.length === 0) return null;

	const activeTask = visibleTasks[0];
	const statusIcon =
		activeTask.status === "failed"
			? "alert-circle"
			: activeTask.status === "running"
				? "sync"
				: "time-outline";
	
	return (
		<View
			pointerEvents="box-none"
			style={[styles.taskDock, { bottom: TAB_BAR_CLEARANCE + insets.bottom }]}
		>
			<View style={[styles.taskCapsule, expanded && styles.taskPanel]}>
				<Pressable
					style={styles.taskHeader}
					onPress={() => setExpanded((value) => !value)}
					accessibilityRole="button"
					accessibilityLabel={expanded ? "收起同步队列" : "展开同步队列"}
				>
					<View
						style={[
							styles.taskIcon,
							activeTask.status === "failed" && styles.taskIconDanger,
							activeTask.status === "running" && styles.taskIconActive,
						]}
					>
						<Ionicons
							name={statusIcon as React.ComponentProps<typeof Ionicons>["name"]}
							size={16}
							color={activeTask.status === "failed" ? colors.danger : colors.primary}
						/>
					</View>
					<View style={styles.taskHeaderText}>
						<Text style={styles.taskTitle} numberOfLines={1}>
							{getCollectionTaskSummary(activeTask)}
						</Text>
						<Text
							style={[
								styles.taskMeta,
								activeTask.status === "failed" && styles.taskError,
							]}
							numberOfLines={1}
						>
							{getTaskStatusLabel(activeTask)}
							{visibleTasks.length > 1 ? ` · 共 ${visibleTasks.length} 个任务` : ""}
						</Text>
					</View>
					{visibleTasks.length > 1 ? (
						<View style={styles.taskCountPill}>
							<Text style={styles.taskCountText}>{visibleTasks.length}</Text>
						</View>
					) : null}
					<Ionicons
						name={expanded ? "chevron-down" : "chevron-up"}
						size={18}
						color={colors.muted}
					/>
				</Pressable>

				{expanded ? (
					<ScrollView
						style={styles.taskList}
						contentContainerStyle={styles.taskListContent}
					>
						{visibleTasks.map((task) => (
							<View key={task.id} style={styles.taskItem}>
								<View style={styles.taskItemText}>
									<Text style={styles.taskItemTitle} numberOfLines={1}>
										{getCollectionTaskSummary(task)}
									</Text>
									<Text
										style={[styles.taskItemMeta, task.status === "failed" && styles.taskError]}
										numberOfLines={1}
									>
										{task.status === "failed" && task.lastError
											? task.lastError
											: getTaskStatusLabel(task)}
									</Text>
								</View>
								{task.status === "failed" ? (
									<Pressable
										style={styles.taskActionButton}
										onPress={() => void retryCollectionTask(task.id)}
										accessibilityRole="button"
										accessibilityLabel="重试同步"
									>
										<Ionicons name="refresh" size={15} color={colors.primary} />
									</Pressable>
								) : null}
								{task.status !== "running" ? (
									<Pressable
										style={styles.taskActionButton}
										onPress={() => void ignoreCollectionTask(task.id)}
										accessibilityRole="button"
										accessibilityLabel="忽略同步任务"
									>
										<Ionicons name="close" size={16} color={colors.muted} />
									</Pressable>
								) : null}
							</View>
						))}
					</ScrollView>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	taskDock: {
		position: "absolute",
		left: 14,
		right: 14,
		zIndex: 20,
	},
	taskCapsule: {
		borderRadius: 24,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.surfaceAlt,
		shadowColor: "#000",
		shadowOpacity: 0.28,
		shadowRadius: 16,
		shadowOffset: { width: 0, height: 8 },
		elevation: 14,
		overflow: "hidden",
	},
	taskPanel: {
		borderRadius: 18,
	},
	taskHeader: {
		minHeight: 58,
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	taskIcon: {
		width: 34,
		height: 34,
		borderRadius: 17,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.chip,
	},
	taskIconActive: {
		backgroundColor: colors.primaryMuted,
	},
	taskIconDanger: {
		backgroundColor: "#3a2429",
	},
	taskHeaderText: {
		flex: 1,
		minWidth: 0,
	},
	taskTitle: {
		color: colors.text,
		fontSize: 13,
		fontWeight: "800",
	},
	taskMeta: {
		marginTop: 2,
		color: colors.muted,
		fontSize: 12,
		fontWeight: "600",
	},
	taskError: {
		color: colors.danger,
	},
	taskCountPill: {
		minWidth: 24,
		height: 24,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 7,
		borderRadius: 12,
		backgroundColor: colors.chip,
	},
	taskCountText: {
		color: colors.primary,
		fontSize: 12,
		fontWeight: "800",
	},
	taskList: {
		maxHeight: 220,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	taskListContent: {
		gap: 7,
		padding: 8,
	},
	taskItem: {
		minHeight: 50,
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingLeft: 10,
		paddingRight: 6,
		paddingVertical: 7,
		borderRadius: 12,
		backgroundColor: colors.surface,
	},
	taskItemText: {
		flex: 1,
		minWidth: 0,
	},
	taskItemTitle: {
		color: colors.text,
		fontSize: 12,
		fontWeight: "700",
	},
	taskItemMeta: {
		marginTop: 2,
		color: colors.muted,
		fontSize: 11,
	},
	taskActionButton: {
		width: 32,
		height: 32,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 16,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.background,
	},
});
