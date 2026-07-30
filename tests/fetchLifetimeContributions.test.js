import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import "@testing-library/jest-dom";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  buildYearRanges,
  fetchLifetimeContributions,
} from "../src/fetchers/lifetime.js";

const repositoryContribution = (nameWithOwner) => ({
  repository: {
    nameWithOwner,
    owner: { login: nameWithOwner.split("/")[0] },
  },
});

const data_account_age = {
  data: {
    user: {
      createdAt: "2024-03-05T10:00:00Z",
    },
  },
};

const data_lifetime = {
  data: {
    user: {
      year2024: {
        totalCommitContributions: 100,
        restrictedContributionsCount: 7,
        commitContributionsByRepository: [
          repositoryContribution("cupidsity/own-private-repo"),
          repositoryContribution("some-org/shared-repo"),
        ],
        issueContributionsByRepository: [
          repositoryContribution("another-org/issues-repo"),
        ],
        pullRequestContributionsByRepository: [
          repositoryContribution("some-org/shared-repo"),
        ],
      },
      year2025: {
        totalCommitContributions: 250,
        restrictedContributionsCount: 0,
        commitContributionsByRepository: [
          repositoryContribution("some-org/shared-repo"),
        ],
        issueContributionsByRepository: [],
        pullRequestContributionsByRepository: [
          repositoryContribution("third-org/pr-repo"),
        ],
      },
      year2026: {
        totalCommitContributions: 50,
        restrictedContributionsCount: 3,
        commitContributionsByRepository: [
          repositoryContribution("cupidsity/own-private-repo"),
        ],
        issueContributionsByRepository: [],
        pullRequestContributionsByRepository: [],
      },
    },
  },
};

const error = {
  errors: [
    {
      type: "NOT_FOUND",
      path: ["user"],
      locations: [],
      message: "Could not resolve to a User with the login of 'noname'.",
    },
  ],
};

const now = new Date("2026-07-29T12:00:00Z");
const mock = new MockAdapter(axios);

beforeEach(() => {
  mock.onPost("https://api.github.com/graphql").reply((cfg) => {
    const req = JSON.parse(cfg.data);
    if (req.query.includes("userCreatedAt")) {
      return [200, data_account_age];
    }
    return [200, data_lifetime];
  });
});

afterEach(() => {
  mock.reset();
});

describe("Test buildYearRanges", () => {
  it("should split the account lifetime into calendar years", () => {
    const yearRanges = buildYearRanges("2024-03-05T10:00:00Z", now);

    expect(yearRanges).toStrictEqual([
      {
        year: 2024,
        from: "2024-03-05T10:00:00.000Z",
        to: "2024-12-31T23:59:59.000Z",
      },
      {
        year: 2025,
        from: "2025-01-01T00:00:00.000Z",
        to: "2025-12-31T23:59:59.000Z",
      },
      {
        year: 2026,
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-07-29T12:00:00.000Z",
      },
    ]);
  });

  it("should return a single range for an account created this year", () => {
    const yearRanges = buildYearRanges("2026-02-01T00:00:00Z", now);

    expect(yearRanges).toStrictEqual([
      {
        year: 2026,
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-07-29T12:00:00.000Z",
      },
    ]);
  });
});

describe("Test fetchLifetimeContributions", () => {
  it("should sum commits across every year", async () => {
    const lifetime = await fetchLifetimeContributions("cupidsity", now);

    // 100 + 250 + 50 public, plus 7 + 0 + 3 in private repositories.
    expect(lifetime.totalCommits).toBe(410);
  });

  it("should request the private commit count for every year", async () => {
    await fetchLifetimeContributions("cupidsity", now);

    const lifetimeRequest = mock.history.post.find((request) =>
      JSON.parse(request.data).query.includes("lifetimeContributions"),
    );

    expect(JSON.parse(lifetimeRequest.data).query).toContain(
      "restrictedContributionsCount",
    );
  });

  it("should count distinct repositories the user does not own", async () => {
    const lifetime = await fetchLifetimeContributions("cupidsity", now);

    expect(lifetime.contributedTo).toBe(3);
  });

  it("should query one aliased collection per year", async () => {
    await fetchLifetimeContributions("cupidsity", now);

    const lifetimeRequest = mock.history.post.find((request) =>
      JSON.parse(request.data).query.includes("lifetimeContributions"),
    );
    const query = JSON.parse(lifetimeRequest.data).query;

    expect(query).toContain("year2024: contributionsCollection");
    expect(query).toContain("year2025: contributionsCollection");
    expect(query).toContain("year2026: contributionsCollection");
  });

  it("should throw specific error when username is invalid", async () => {
    await expect(fetchLifetimeContributions("asdf///---", now)).rejects.toThrow(
      new Error("Invalid username provided."),
    );
  });

  it("should throw when the user cannot be resolved", async () => {
    mock.reset();
    mock.onPost("https://api.github.com/graphql").reply(200, error);

    await expect(fetchLifetimeContributions("noname", now)).rejects.toThrow(
      "Could not resolve to a User with the login of 'noname'.",
    );
  });
});
