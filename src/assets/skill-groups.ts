import { resolveResource } from "@tauri-apps/api/path";
import { readTextFile } from "@tauri-apps/plugin-fs";

type SkillGroupMapping = {
  [key: string]: {
    [key: string]: {
      skills: number[];
    };
  };
};

const loadSkillGroups = async () => {
  const resourcePath = await resolveResource("assets/skill-groups.json");
  return JSON.parse(await readTextFile(resourcePath));
};

const SkillGroups = (await loadSkillGroups()) as SkillGroupMapping;

export default SkillGroups;
