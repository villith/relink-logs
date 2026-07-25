import { readTextFile } from "@tauri-apps/api/fs";
import { resolveResource } from "@tauri-apps/api/path";

import { setSkillNameSources, type SkillNameSources } from "@/skillNameSources";

const loadSkillNameSources = async () => {
  const resourcePath = await resolveResource("assets/skill-name-sources.json");
  return JSON.parse(await readTextFile(resourcePath));
};

const SkillNameSourcesData = (await loadSkillNameSources()) as SkillNameSources;

setSkillNameSources(SkillNameSourcesData);

export default SkillNameSourcesData;
