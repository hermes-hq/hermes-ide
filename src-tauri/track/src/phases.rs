//! Tracks, phases, gates, line caps and the built-in phase prompts.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Track {
    Quick,
    Light,
    Full,
}

impl Track {
    pub const NAMES: &'static [(&'static str, Track)] = &[
        ("Quick", Track::Quick),
        ("Light", Track::Light),
        ("Full", Track::Full),
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Track::Quick => "Quick",
            Track::Light => "Light",
            Track::Full => "Full",
        }
    }

    /// Case-insensitive, so `--track full` works.
    pub fn parse(value: &str) -> Option<Track> {
        Track::NAMES
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(value.trim()))
            .map(|(_, t)| *t)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase {
    Questions,
    Research,
    Design,
    Structure,
    Plan,
    Implement,
    Done,
}

impl Phase {
    pub const NAMES: &'static [(&'static str, Phase)] = &[
        ("questions", Phase::Questions),
        ("research", Phase::Research),
        ("design", Phase::Design),
        ("structure", Phase::Structure),
        ("plan", Phase::Plan),
        ("implement", Phase::Implement),
        ("done", Phase::Done),
    ];

    pub fn as_str(self) -> &'static str {
        Phase::NAMES
            .iter()
            .find(|(_, p)| *p == self)
            .map(|(n, _)| *n)
            .unwrap_or("done")
    }

    pub fn parse(value: &str) -> Option<Phase> {
        Phase::NAMES
            .iter()
            .find(|(n, _)| *n == value.trim())
            .map(|(_, p)| *p)
    }

    /// The markdown file the phase produces; `implement` and `done` have none
    /// (the code is the artifact).
    pub fn file_name(self) -> Option<&'static str> {
        match self {
            Phase::Questions => Some("questions.md"),
            Phase::Research => Some("research.md"),
            Phase::Design => Some("design.md"),
            Phase::Structure => Some("structure.md"),
            Phase::Plan => Some("plan.md"),
            Phase::Implement | Phase::Done => None,
        }
    }

    /// The most lines the phase's file may have: short enough to read in the
    /// editor in a minute. A longer file means the feature is too big.
    pub fn line_cap(self) -> Option<usize> {
        match self {
            Phase::Questions => Some(40),
            Phase::Research => Some(80),
            Phase::Design => Some(80),
            Phase::Structure => Some(60),
            Phase::Plan => Some(120),
            Phase::Implement | Phase::Done => None,
        }
    }

    /// The built-in prompt (`.hermes/phases/<phase>.md` overrides it).
    pub fn default_prompt(self) -> Option<&'static str> {
        match self {
            Phase::Questions => Some(include_str!("../phases/questions.md")),
            Phase::Research => Some(include_str!("../phases/research.md")),
            Phase::Design => Some(include_str!("../phases/design.md")),
            Phase::Structure => Some(include_str!("../phases/structure.md")),
            Phase::Plan => Some(include_str!("../phases/plan.md")),
            Phase::Implement => Some(include_str!("../phases/implement.md")),
            Phase::Done => None,
        }
    }
}

/// Every phase with a prompt, in order.
pub const PROMPTED_PHASES: &[Phase] = &[
    Phase::Questions,
    Phase::Research,
    Phase::Design,
    Phase::Structure,
    Phase::Plan,
    Phase::Implement,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    None,
    Waiting,
    Approved,
}

impl Gate {
    pub const NAMES: &'static [(&'static str, Gate)] = &[
        ("none", Gate::None),
        ("waiting", Gate::Waiting),
        ("approved", Gate::Approved),
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Gate::None => "none",
            Gate::Waiting => "waiting",
            Gate::Approved => "approved",
        }
    }
}

/// The phases a track runs, in order (`done` is implicit at the end).
pub fn track_phases(track: Track) -> &'static [Phase] {
    match track {
        Track::Quick => &[],
        Track::Light => &[Phase::Questions, Phase::Plan, Phase::Implement],
        Track::Full => &[
            Phase::Questions,
            Phase::Research,
            Phase::Design,
            Phase::Structure,
            Phase::Plan,
            Phase::Implement,
        ],
    }
}

/// The phase after `phase` on the track; `Done` after the last one, and for
/// a phase the track does not have, the first track phase after it.
pub fn next_phase(track: Track, phase: Phase) -> Phase {
    track_phases(track)
        .iter()
        .copied()
        .find(|p| *p > phase)
        .unwrap_or(Phase::Done)
}

/// A prompt file is the prompt text, then an optional `## Template` section
/// holding the artifact's starting content.
pub fn split_prompt(text: &str) -> (String, String) {
    let marker = "\n## Template";
    match text.find(marker) {
        Some(at) => {
            let prompt = text[..at].trim_end().to_string();
            let rest = &text[at + marker.len()..];
            let template = rest.trim_start_matches(['\r', '\n']);
            (prompt, template.trim_end().to_string())
        }
        None => (text.trim_end().to_string(), String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_run_their_phases_in_order() {
        assert_eq!(track_phases(Track::Quick), &[] as &[Phase]);
        assert_eq!(next_phase(Track::Light, Phase::Questions), Phase::Plan);
        assert_eq!(next_phase(Track::Light, Phase::Plan), Phase::Implement);
        assert_eq!(next_phase(Track::Light, Phase::Implement), Phase::Done);
        assert_eq!(next_phase(Track::Full, Phase::Questions), Phase::Research);
        assert_eq!(next_phase(Track::Full, Phase::Structure), Phase::Plan);
        // A phase the track skips still moves to the next one it has.
        assert_eq!(next_phase(Track::Light, Phase::Design), Phase::Plan);
        assert_eq!(next_phase(Track::Quick, Phase::Questions), Phase::Done);
    }

    #[test]
    fn names_round_trip() {
        for (name, phase) in Phase::NAMES {
            assert_eq!(Phase::parse(name), Some(*phase));
            assert_eq!(phase.as_str(), *name);
        }
        assert_eq!(Track::parse("full"), Some(Track::Full));
        assert_eq!(Track::parse("nope"), None);
        assert_eq!(Gate::Waiting.as_str(), "waiting");
    }

    #[test]
    fn every_prompted_phase_has_a_prompt_and_the_plan_has_a_template() {
        for phase in PROMPTED_PHASES {
            let text = phase.default_prompt().expect("prompt");
            let (prompt, _) = split_prompt(text);
            assert!(
                prompt.starts_with(&format!("# Phase: {}", phase.as_str())),
                "{prompt}"
            );
        }
        let (_, template) = split_prompt(Phase::Plan.default_prompt().unwrap());
        assert!(template.starts_with("# Plan"));
        let (_, none) = split_prompt(Phase::Implement.default_prompt().unwrap());
        assert_eq!(none, "");
        assert_eq!(
            split_prompt("just text\n"),
            ("just text".to_string(), String::new())
        );
    }
}
