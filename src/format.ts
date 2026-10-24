const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
export const formatNumber = (value: number) => number.format(value);
export const formatDate = (value: string) => date.format(new Date(value));
