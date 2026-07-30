// @ts-check

import * as dotenv from "dotenv";
import githubUsernameRegex from "github-username-regex";
import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { CustomError } from "../common/error.js";
import { wrapTextMultiline } from "../common/fmt.js";
import { request } from "../common/http.js";

dotenv.config();

// Repository lists that a single contributionsCollection field will return.
const CONTRIBUTION_REPOSITORY_FIELDS = [
  "commitContributionsByRepository",
  "issueContributionsByRepository",
  "pullRequestContributionsByRepository",
];

// GitHub caps every *ContributionsByRepository field at 100 repositories per year.
const MAX_REPOSITORIES_PER_YEAR = 100;

const GRAPHQL_ACCOUNT_AGE_QUERY = `
  query userCreatedAt($login: String!) {
    user(login: $login) {
      createdAt
    }
  }
`;

/**
 * Build a GraphQL query that reads one contributionsCollection per year.
 *
 * A contributionsCollection may only span a single year, so each year gets its
 * own aliased field and the whole lifetime is read in one request.
 *
 * @param {{year: number, from: string, to: string}[]} yearRanges Year ranges to query.
 * @returns {string} GraphQL query.
 */
const buildLifetimeQuery = (yearRanges) => {
  const repositoryFields = CONTRIBUTION_REPOSITORY_FIELDS.map(
    (field) => `
        ${field}(maxRepositories: ${MAX_REPOSITORIES_PER_YEAR}) {
          repository {
            nameWithOwner
            owner {
              login
            }
          }
        }`,
  ).join("");

  const yearFields = yearRanges
    .map(
      ({ year, from, to }) => `
      year${year}: contributionsCollection(from: "${from}", to: "${to}") {
        totalCommitContributions
        restrictedContributionsCount${repositoryFields}
      }`,
    )
    .join("");

  return `
    query lifetimeContributions($login: String!) {
      user(login: $login) {${yearFields}
      }
    }
  `;
};

/**
 * Fetcher for the account creation date.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} variables.login GitHub username.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const accountAgeFetcher = (variables, token) => {
  return request(
    {
      query: GRAPHQL_ACCOUNT_AGE_QUERY,
      variables: { login: variables.login },
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Fetcher for every year of contributions the account has.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} variables.login GitHub username.
 * @param {{year: number, from: string, to: string}[]} variables.yearRanges Year ranges to query.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const lifetimeContributionsFetcher = (variables, token) => {
  return request(
    {
      query: buildLifetimeQuery(variables.yearRanges),
      variables: { login: variables.login },
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Split the span between the account creation date and now into calendar years.
 *
 * @param {string} createdAt Account creation timestamp.
 * @param {Date} now Current time.
 * @returns {{year: number, from: string, to: string}[]} One range per calendar year.
 */
const buildYearRanges = (createdAt, now) => {
  const accountCreated = new Date(createdAt);
  const firstYear = accountCreated.getUTCFullYear();
  const currentYear = now.getUTCFullYear();

  const yearRanges = [];
  for (let year = firstYear; year <= currentYear; year++) {
    const yearStart =
      year === firstYear
        ? accountCreated
        : new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    const yearEnd =
      year === currentYear ? now : new Date(Date.UTC(year, 11, 31, 23, 59, 59));

    yearRanges.push({
      year,
      from: yearStart.toISOString(),
      to: yearEnd.toISOString(),
    });
  }

  return yearRanges;
};

/**
 * Turn a GraphQL error payload into a thrown CustomError.
 *
 * @param {import('axios').AxiosResponse} response Axios response.
 * @returns {void}
 */
const throwGraphQLError = (response) => {
  const errors = response.data.errors;
  logger.error(errors);

  if (errors[0].type === "NOT_FOUND") {
    throw new CustomError(
      errors[0].message || "Could not fetch user.",
      CustomError.USER_NOT_FOUND,
    );
  }
  if (errors[0].message) {
    throw new CustomError(
      wrapTextMultiline(errors[0].message, 90, 1)[0],
      response.statusText,
    );
  }
  throw new CustomError(
    "Something went wrong while trying to retrieve the lifetime contributions using the GraphQL API.",
    CustomError.GRAPHQL_ERROR,
  );
};

/**
 * Fetch lifetime commit and repository contribution totals for a user.
 *
 * Both numbers come from the GraphQL contributionsCollection, which counts
 * private contributions when the configured PAT belongs to the queried user.
 * The REST commit search used by `include_all_commits` cannot see those.
 *
 * `contributedTo` counts distinct repositories the user does not own, matching
 * the `includeUserRepositories: false` default of `repositoriesContributedTo`.
 *
 * @param {string} username GitHub username.
 * @param {Date} now Current time, injectable for tests.
 * @returns {Promise<{totalCommits: number, contributedTo: number}>} Lifetime totals.
 */
const fetchLifetimeContributions = async (username, now = new Date()) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username provided.");
    throw new Error("Invalid username provided.");
  }

  const accountAgeResponse = await retryer(accountAgeFetcher, {
    login: username,
  });
  if (accountAgeResponse.data.errors) {
    throwGraphQLError(accountAgeResponse);
  }

  const createdAt = accountAgeResponse.data.data.user.createdAt;
  if (!createdAt) {
    throw new CustomError(
      "Could not fetch the account creation date.",
      CustomError.GRAPHQL_ERROR,
    );
  }

  const yearRanges = buildYearRanges(createdAt, now);
  const contributionsResponse = await retryer(lifetimeContributionsFetcher, {
    login: username,
    yearRanges,
  });
  if (contributionsResponse.data.errors) {
    throwGraphQLError(contributionsResponse);
  }

  const contributionsByYear = contributionsResponse.data.data.user;
  const ownerLogin = username.toLowerCase();
  const contributedRepositories = new Set();
  let totalCommits = 0;

  for (const { year } of yearRanges) {
    const yearContributions = contributionsByYear[`year${year}`];
    if (!yearContributions) {
      continue;
    }

    // Commits in private repositories are reported separately unless the
    // account enables "Include private contributions on my profile". When it is
    // enabled they are already inside totalCommitContributions and the
    // restricted count is zero, so adding both never double counts.
    totalCommits +=
      yearContributions.totalCommitContributions +
      yearContributions.restrictedContributionsCount;

    for (const field of CONTRIBUTION_REPOSITORY_FIELDS) {
      for (const contribution of yearContributions[field] ?? []) {
        const repository = contribution.repository;
        if (repository.owner.login.toLowerCase() !== ownerLogin) {
          contributedRepositories.add(repository.nameWithOwner);
        }
      }
    }
  }

  return { totalCommits, contributedTo: contributedRepositories.size };
};

export { fetchLifetimeContributions, buildYearRanges };
export default fetchLifetimeContributions;
