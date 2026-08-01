import { Button, Group, TextInput } from "@mantine/core";

/** The picked-path row shared by the database import modals: a read-only path
 * display and the button that opens a native picker. Native, NOT a browser
 * file input: a webview `<input type="file">` yields a File with no real
 * filesystem path, and the backend needs the path to open the database. */
const DbFilePicker = ({
  path,
  placeholder,
  browseLabel,
  onBrowse,
  disabled,
}: {
  path: string | null;
  /** Shown in the empty input and read to screen readers. */
  placeholder: string;
  browseLabel: string;
  onBrowse: () => void;
  disabled: boolean;
}) => (
  <Group gap="xs" wrap="nowrap">
    <TextInput style={{ flex: 1 }} readOnly value={path ?? ""} placeholder={placeholder} aria-label={placeholder} />
    <Button variant="default" onClick={onBrowse} disabled={disabled}>
      {browseLabel}
    </Button>
  </Group>
);

export default DbFilePicker;
