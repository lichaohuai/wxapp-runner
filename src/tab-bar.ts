export type TabBadge = {
  type: "text" | "redDot" | "none";
  badgeValue?: string;
};

/** Native setTabBarBadge envelope produced by the real base library. */
export class TabBarState {
  private badges: Record<number, TabBadge> = {};
  constructor(private config: any) {}
  updateBadge(args: any) {
    const list = this.config?.list;
    if (
      !Array.isArray(list) ||
      !Number.isInteger(args.index) ||
      args.index < 0 ||
      args.index >= list.length
    )
      throw Error("tabBar index out of range");
    if (!["text", "redDot", "none"].includes(args.type))
      throw Error("invalid tabBar badge type");
    if (args.type === "text" && typeof args.badgeValue !== "string")
      throw Error("badgeValue must be a string");
    this.badges[args.index] =
      args.type === "text"
        ? { type: "text", badgeValue: args.badgeValue }
        : { type: args.type };
    return this.snapshot();
  }
  snapshot() {
    return structuredClone(this.badges);
  }
}
