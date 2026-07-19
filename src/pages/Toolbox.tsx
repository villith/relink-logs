import { Box, Flex, NavLink } from "@mantine/core";
import { Flask } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router-dom";

/** Toolbox: fixed 300px tool menu on the left, the selected tool on the right. */
const ToolboxPage = () => {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <Flex gap="md" align="flex-start">
      <Box w={300} style={{ flexShrink: 0 }}>
        <NavLink
          component={Link}
          to="/logs/toolbox/synthesis"
          label={t("ui.toolbox.synthesis-helper", "Synthesis Helper")}
          leftSection={<Flask size="1rem" />}
          active={pathname.startsWith("/logs/toolbox/synthesis")}
        />
      </Box>
      <Box style={{ flexGrow: 1, minWidth: 0 }}>
        <Outlet />
      </Box>
    </Flex>
  );
};

export default ToolboxPage;
