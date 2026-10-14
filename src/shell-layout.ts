/** The base library owns custom tab bars; only standard tabs reserve host space. */
export function pageChrome(app: any, route: string, tabBarHidden = false) {
  const isTab = !!app.tabBar?.list?.some(
    (item: any) => item.pagePath.replace(/\.html$/, "") === route,
  );
  const showTabBar = isTab && app.tabBar?.custom !== true && !tabBarHidden;
  const navigationStyle =
    app.page?.[route + ".html"]?.window?.navigationStyle ??
    app.global?.window?.navigationStyle;
  const showNavigationBar = navigationStyle !== "custom";
  return {
    isTab,
    showTabBar,
    tabBarHeight: showTabBar ? 58 : 0,
    showNavigationBar,
    navigationBarHeight: showNavigationBar ? 36 : 0,
  };
}
