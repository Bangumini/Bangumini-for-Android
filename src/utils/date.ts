export function getBangumiWeekday(date = new Date()) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

export function formatDate(value?: string | null) {
  if (!value) return "日期未知";
  return value;
}

export function formatAiringTime(airingAt?: number | null) {
  if (!airingAt) return "时间未定";
  const date = new Date(airingAt * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}
