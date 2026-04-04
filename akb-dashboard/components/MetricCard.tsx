interface MetricCardProps {
  label: string;
  value: number | string;
  color: string;
}

export default function MetricCard({ label, value, color }: MetricCardProps) {
  const colorMap: Record<string, string> = {
    orange: "border-orange-500 text-orange-400",
    yellow: "border-yellow-500 text-yellow-400",
    blue: "border-blue-500 text-blue-400",
    gray: "border-gray-500 text-gray-400",
    green: "border-emerald-500 text-emerald-400",
    purple: "border-purple-500 text-purple-400",
    red: "border-red-500 text-red-400",
    teal: "border-teal-500 text-teal-400",
  };

  const classes = colorMap[color] || colorMap.gray;

  return (
    <div className={`bg-[#1c2128] rounded-lg border-l-4 ${classes.split(" ")[0]} p-4`}>
      <p className="text-xs uppercase tracking-wider text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${classes.split(" ")[1]}`}>{value}</p>
    </div>
  );
}
