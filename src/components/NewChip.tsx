import { isNew, NewFeatureId } from "@/newFeatures";
import { Badge } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** The chip's color — shared with the collapsed-menu "new" indicator dots. */
export const NEW_CHIP_COLOR = "teal";

/** "New" chip marking a recently shipped feature; renders nothing without an
 * `id` or once the app version moves past the release listed for it in
 * NEW_FEATURES. */
const NewChip = ({ id }: { id?: NewFeatureId }) => {
  const { t } = useTranslation();
  if (!id || !isNew(id)) return null;
  return (
    <Badge size="xs" variant="filled" color={NEW_CHIP_COLOR}>
      {t("ui.new-chip", "New")}
    </Badge>
  );
};

export default NewChip;
