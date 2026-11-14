import { useLocalSearchParams } from "expo-router";
import { BrainGroupScreen } from "@/features/ai/BrainGroupScreen";

/** A brain group (ADR 0180) to change or delete, or `new` to make one: from "Grupos" in IA e uso. */
export default function BrainGroupRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <BrainGroupScreen id={id ?? "new"} />;
}
